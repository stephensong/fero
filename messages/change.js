// TODO: should use parameterised version
const Constants = require('../constants')
    , constants = new Constants() 
    , deb = require('../deb')('cha'.bgBlack.bold)
    , define = Object.defineProperty
    , { extend, str, parse, is, clone } = require('utilise/pure')

module.exports = Change

function Change(type, key, value){
  if (typeof arguments[0] === 'object') {
    this.key = arguments[0].key
    this.type = arguments[0].type
    this.value = typeof arguments[0].value === 'object' ? clone(arguments[0].value) : arguments[0].value
  } else {
    this.key = key
    this.type = type
    this.value = typeof value === 'object' ? clone(value) : value
  }
}

// lazy getters, only serialise/deserialise on first access
define(Change.prototype, 'buffer', {
  get: function(){ return this._buffer || this.serialise() }
})

Change.prototype.serialise = function() {
  if (typeof this.key !== 'string') 
    this.key = typeof this.key === 'number' ? ''+this.key : ''
  
  let v
  /// TODO: Add boolean type too
  const vtype = typeof this.value === 'object'    ? (v = JSON.stringify(this.value), constants.types.json)
              : typeof this.value === 'undefined' ? (v = ''                         , constants.types.undefined)
              : typeof this.value === 'number'    ? (v = ''+this.value             , constants.types.number)
                                                   : (v = this.value                , constants.types.string)
  this._buffer = Buffer.allocUnsafe(3 + this.key.length + Buffer.byteLength(v)) // TODO recycle buffers
  this._buffer[0] = constants.change[this.type]
  this._buffer[1] = this.key.length
  this._buffer[2] = vtype
  this._buffer.fill(this.key, 3, 3 + this.key.length)
  this._buffer.fill(v, 3 + this.key.length)
  return this._buffer
}