module.exports = Peer

function Peer(peers, host, port, socket, server) {
  define(this, 'uuid'   , { enumerable: true, value: ` ${~~(Math.random()*90) + 10} ` }) // TODO UUID
  define(this, 'status' , { enumerable: true, value: '', writable: true })
  def(this, '_socket'   , null, 1)
  def(this, 'peers'     , peers)
  def(this, 'host'      , host, 1)
  def(this, 'port'      , port, 1)
  def(this, 'server'    , !!server, 1)
  def(this, 'retry'     , 0, 1)
  def(this, 'hw'        , { inbox: 0, outbox: 0, yacks: 0 })
  def(this, 'lw'        , { inbox: 0, outbox: 0, yacks: 0 })
  def(this, 'tacks'     , 0, 1)
  def(this, 'inbox'     , [], 1)
  def(this, 'outbox'    , Buffer.allocUnsafe(this.peers.constants.outbox.max), 1)
  def(this, 'buffer'    , { filling: 0, tack: 0, offset: 0, len: 0, hw: 0, lenc: 0, frag: 0/*Buffer.alloc(this.peers.constants.outbox.frag)*/ }) // TODO dynamically allocate based on len
  def(this, 'timeouts'  , {})
  this.setStatus('disconnected', this.address)
  this.socket = socket
}

const define = Object.defineProperty
    , { emit, formatID } = require('./utils')
    , { wait, def, is, debounce, values, str, remove, update, time, not } = require('utilise/pure')
    , { connect } = require('./handshake')
    , { Message, Ack } = require('./messages')

define(Peer.prototype, 'address', {
  get: function(){ return `${this.host}:${this.port}` }
})

define(Peer.prototype, 'id', {
  enumerable: true
, get: function(){ return formatID(this.address) }
})

define(Peer.prototype, 'socket', {
  get: function(s){ return this._socket }
, set: function(s){ 
    if (this._socket)
      this._socket.removeAllListeners()

    this._socket = s

    if (this._socket) {
      this._socket.setNoDelay(true)
      this._socket.on('close', this.fail.bind(this))
      this._socket.on('error', this.error.bind(this))
      this._socket.on('data' , this.data.bind(this))      
    } 
  }
})

Peer.prototype.connect = connect

Peer.prototype.fail = function(){
  delete clearTimeout(this.timeouts.flushout)
  delete clearTimeout(this.timeouts.flushin)
  this.hw.outbox = 0
  if (this.status == 'removed') return deb('retry skip (removed)') // TODO: Throw on write fail
  if (!this.server) return deb('retry skip', this.uuid.bgRed), this.peers.remove(this)
  if (this.retry >= this.peers.retries.max) {
    deb('retries exceeded', this.peers.retries.max, this.id)
    return this.peers.remove(this)
  } 

  const delay = this.peers.retries.retry(this.retry++)
  deb(`retrying ${str(this.retry).yellow}/${this.peers.retries.max} in ${str(delay).yellow} ms`, this.uuid.bgRed)
  this.timeouts.retry = time(delay, this.connect.bind(this))
  this.socket = null
  this.setStatus('throttled')
}

Peer.prototype.error = function(e){
  return e.code == 'ECONNRESET'   ? deb('left'.red, this.address.grey, this.uuid.bgRed)
       : e.code == 'ECONNREFUSED' ? deb('refused'.red, this.address.grey, this.uuid.bgRed)
       : e.code == 'ECONNABORTED' ? deb('aborted'.red, this.address.grey, this.uuid.bgRed)
                                  : deb('unhandled'.red, e.message, this.address.grey, this.uuid.bgRed)
}

function Guarantees(peer){
  this.peer = peer
  this.tack = peer.tacks
}

Guarantees.prototype.on = function(event, fn){
  const cache = this.peer.peers.cache
  if (fn) {
    return event == 'ack'   ? cache
            .on('ack', this.fn = m => this.ack(m) && (cache.off('ack', this.fn), fn(m)))
         : event == 'reply' ? cache
            .on('reply', this.fn = m => this.reply(m) && (cache.off('reply', this.fn), fn(m)))
         : new Error('invalid guarantee')
  } else {
    return event === 'ack' ? cache
            .on('ack.guarantees')
            .filter((m, i, n) => this.ack(m) && n.unsubscribe())
         : event === 'reply' ? cache
            .on('reply.guarantees')
            .filter((m, i, n) => this.reply(m) && n.unsubscribe())
            .map(m => new Message(m.buffer.slice(4)))
         : event === 'commit' ? 42 /* TODO */
         : new Error('invalid guarantee')
  }
}

Guarantees.prototype.ack = function(m){
  return m.peer == this.peer && m.value >= this.tack
}

Guarantees.prototype.reply = function(m, fn){
  return m.peer == this.peer && m.buffer.readUInt32LE() == this.tack
}

Peer.prototype.send = function(message, command = this.peers.constants.commands.proxy) {
  if (!message) return
  if (!message.length) message = str(message) 
  const len = Buffer.byteLength(message)

  // flush
  if (len > this.outbox.length - this.hw.outbox - 6) {
    if (!this.socket || this.socket.destroyed) return this.fail()
    this.socket.write(this.outbox.slice(0, this.hw.outbox))
    this.outbox = Buffer.allocUnsafe(this.peers.constants.outbox.max)
    this.hw.outbox = 0
    this.peers.cache.emit('tack', { value: this.tacks, peer: this })
    
    // TODO: only if too long?
    if (len > this.outbox.length - 6) {
      const long = Buffer.allocUnsafe(len+6)
      long[0] = 124
      long[1] = command
      long.writeUInt32BE(len, 2)
      long.fill(message, 6)

      this.socket.write(long)
      // this.socket.write(Buffer.from(long))

      if (command === this.peers.constants.commands.proxy) {
        this.peers.cache.emit('tack', { value: ++this.tacks, peer: this })
        return new Guarantees(this)
      }
      return
    }
  } 

  this.outbox[this.hw.outbox] = 124
  this.outbox[this.hw.outbox+1] = command
  this.outbox.writeUInt32BE(len, this.hw.outbox+2)
  this.outbox.fill(message, this.hw.outbox + 6, this.hw.outbox = this.hw.outbox + len + 6)
  !this.timeouts.flushout && (this.timeouts.flushout = p.then(d => {
    if (!this.socket || this.socket.destroyed) return this.fail()
    this.socket.write(Buffer.from(this.outbox.slice(0, this.hw.outbox)))
    this.peers.cache.emit('tack', { value: this.tacks, peer: this })
    this.hw.outbox = this.timeouts.flushout = 0
  }))
  if (command === this.peers.constants.commands.proxy) {
    this.tacks++
    return new Guarantees(this)
  }
}

Peer.prototype.data = function(data){
  for (let i = 0; i < data.length; i++) {
    if (this.buffer.filling) {
      if (!this.buffer.command)
        this.buffer.command = data[i]
      else if (this.buffer.lenc != 4) {
        this.buffer.len = data[i] + (this.buffer.len << 8)
        this.buffer.lenc++
      } else if (this.buffer.frag) {
        this.buffer.frag[this.buffer.offset++] = data[i]
        if (this.buffer.offset === this.buffer.len) {
          this.buffer.command & this.peers.constants.commands.proxy && this.hw.yacks++
          this.buffer.command & this.peers.constants.commands.ack
            ? this.peers.cache.emit('ack', new Ack(this.buffer.frag, this))
            : this.inbox.push(new Message(this.buffer.frag, this, this.buffer.command, this.hw.yacks))
          this.buffer.filling = this.buffer.command = this.buffer.len = this.buffer.lenc = this.buffer.offset = this.buffer.frag = 0
        }
      } else if ((this.buffer.end = i + this.buffer.len) > data.length) {
        (this.buffer.frag = Buffer.allocUnsafe(this.buffer.len))
        [this.buffer.offset++] = data[i]
      } else {
        this.buffer.command & this.peers.constants.commands.proxy && this.hw.yacks++
        this.buffer.command & this.peers.constants.commands.ack
          ? this.peers.cache.emit('ack', new Ack(data.slice(i, i = this.buffer.end), this))
          : this.inbox.push(new Message(data.slice(i, i = this.buffer.end), this, this.buffer.command, this.hw.yacks))
        this.buffer.filling = this.buffer.command = this.buffer.len = this.buffer.lenc = 0
        i--
      }
    } else {
      this.buffer.filling = (data[i] === 0x7c)
    }
  }

  this.hw.yacks !== this.lw.yacks &&
    this.socket.write(Buffer.from((yack.writeDoubleBE(this.lw.yacks = this.hw.yacks, 6), yack)))  

  !this.timeouts.flushin && (this.timeouts.flushin = setTimeout(d => {
    this.timeouts.flushin = 0
    for (let j = 0; j < this.inbox.length; j++)
      this.peers.cache.emit(this.peers.constants.commands[this.inbox[j].command], this.inbox[j])
    this.inbox = []
  }))
}

const { avg, ms, dp } = require('./utils')

const yack = Buffer.from([124,32,0,0,0,8,0,0,0,0,0,0,0,0])

Peer.prototype.setStatus = function(status, address){
  if (!status || this.status == status) return console.log("should not be called", this.status, status)// TODO needed?

  // TODO: This should move into pre-handshake
  if (address) {
    let existing = this.peers[formatID(address)]
    if (existing && existing != this) {
      if (existing.status == 'connected') {
        deb('active peer exists', existing.id, existing.uuid.bgRed)
        return this.peers.remove(this)
      } else {
        deb('inactive peer exists', existing.id, existing.uuid.bgRed)
        this.peers.remove(existing)
      }
    }
  }
  
  if (this.status) 
    this.peers.lists[this.status] = this.peers.lists[this.status].filter(not(is(this)))

  if (address) {
    remove(this.id)(this.peers)
    const [h, p] = address.split(':')
    this.host = h
    this.port = p
    update(this.id, this)(this.peers)
  } 

  this.status = status
  if (status != 'removed') this.peers.lists[status].push(this)
  if (status == 'connected') this.retry = 0
  this.peers.lists.all = [].concat(this.peers.lists.connected, this.peers.lists.disconnected, this.peers.lists.connecting, this.peers.lists.client)
  this.peers.cache.emit('status', [status, this])
}

const deb = require('./deb')('per'.bgGreen.bold)
    , p = Promise.resolve()