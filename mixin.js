'use strict'

import immutable from 'immutable'
import {atom, derivation, isDerivable, lens, transact} from 'derivable'
import React, {
  Text,
  View
} from 'react-native'

// global.immutable = immutable
// global.Record = immutable.Record
// global.List = immutable.List
// global.IMap = immutable.Map
// global.ISet = immutable.Set
// global.atom = atom
// global.isDerivable = isDerivable
// global.derivation = derivation
// global.transact = transact
// global.lens = lens

if (!console.debug) {
  console.debug = console.log
}

let nextId = 0
let _forceUpdateStack = []

const mixin = {
  getInitialState() {
    this.id = nextId++
    this.displayName = this.constructor.displayName
    this._intervalIds = {}
    this._timeoutIds = {}
    this._mounted = false
    this.$isMounted = atom(false)
    this.$isUnmounted = atom(false)
    this._$mRender = atom(this.mRender) // Hot reloading mutates this
    this._gonnaUpdate = false

    this.$ = {} // our derivable-powered equivalent of this.state

    if (this.debug) {
      console.debug(`${this}.init`)
    }

    if (this.constructor.contextTypes) {
      this.con = {}
      for (let contextName in this.constructor.contextTypes) {
        this.con[contextName] = atom(this.context[contextName])
      }
    }

    if (this.init) {
      this.init()
    }

    this.mRenderDerivation = derivation(() => {
      return this._$mRender.get()()
    })
    this.mRenderReactor = this.mRenderDerivation.reactor(() => {
      if (_forceUpdateStack.length) {
        // You'd think we wouldn't ever be forceUpdating components out of order,
        // but there are two known reasons why this happens.
        // 1. A prop atom gets updated in componentWillReceiveProps, before the
        //    render cascade reaches this component.
        // 2. Firebase-related issue:
        //    When we do a Firebase .on call, it tries to see if it can synchronously
        //    call our callback with some already-present data. But this component's
        //    init() and initData() which might have resulted from its ancestor's
        //    Firebase "on" callback triggering a state change. In that case, Firebase
        //    will now want to keep iterating through its original callback queue
        //    before calling the new callback we are registering. That might
        //    cause a different component to change its state and forceUpdate while
        //    while we are still initting and rendering this component here.
        if (this.debug) {
          console.debug(
            this + ' forceUpdate (async because blocked)' +
            (this._gonnaUpdate? ' ...already gonna render' : undefined)
          )
        }
        if (!this._gonnaUpdate) {
          this._gonnaUpdate = true
          this.setTimeout(() => {
            this._gonnaUpdate = false
            if (this._mounted) {
              _forceUpdateStack.push(this)
              this.forceUpdate(() => {
                _forceUpdateStack.pop()
                if (this.debug) {
                  console.debug('...' + this + ' forceUpdate done')
                }
              })
            }
          })
        }
      } else {
        if (this.debug) {
          console.debug(this + ' forceUpdate')
        }
        _forceUpdateStack.push(this)
        this.forceUpdate(() => {
          _forceUpdateStack.pop()
          if (this.debug) {
            console.debug('... ' + this + ' forceUpdate done')
          }
        })
      }
    })
    this.mRenderReactor.start()

    this._$dirtyContext = atom(false)
    this._contextReactor = M.contextDer.reactor(() => {
      // If any ancestor component is using context, we need
      // all the components in between to refresh themselves.
      // Right now our crude solution is to invalidate all
      // render derivations whenever M.context is updated.
      this._$dirtyContext.set(true)
      if (this.displayName == 'MMain' || this.getChildContext) {
        // The setTimeout is because we want to make sure all the subcomponents
        // have time to get their _$dirtyContext set to true before the
        // forceUpdate triggers the cascade of shouldComponentUpdate calls
        if (!this._gonnaUpdate) {
          this._gonnaUpdate = true
          setTimeout(() => {
            this._gonnaUpdate = false
            if (this._mounted) {
              if (this.debug) {
                console.debug(this + ' forceUpdate (async)')
              }
              _forceUpdateStack.push(this)
              this.forceUpdate(() => {
                _forceUpdateStack.pop()
                if (this.debug) {
                  console.debug('... ' + this + ' forceUpdate done')
                }
              })
            }
          })
        }
      }
    })
    this._contextReactor.start()

    this.renderDerivation = derivation(() => {
      this._$dirtyContext.get()
      return this.mRender()
    })

    return null
  },

  initPro(pro) {
    this.pro = pro

    this._derivableProps = {}
    this._derivablePropReactors = {}

    for (let propName in this.props) {
      if (this.pro[propName]) {
        if (isDerivable(this.props[propName])) {
          this._derivableProps[propName] = this.props[propName]
          this._derivablePropReactors[propName] = this.props[propName].reactor(
            propValue => this.pro[propName].set(propValue)
          )
          this._derivablePropReactors[propName].start().force()

        } else {
          this.pro[propName].set(this.props[propName])
        }
      }
    }
  },

  initData(dataConfig) {
    // Turn on reactive Firebase queries
    this.dataConfig = dataConfig
    this.data = {}

    for (let dataKey in this.dataConfig) {
      // Shorthand for quickly mapping a Firebase ref into an atom
      if (typeof this.dataConfig[dataKey] == 'function' || this.dataConfig[dataKey] instanceof Array) {
        this.dataConfig[dataKey] = {
          ref: this.dataConfig[dataKey],
          value: true
        }
      }

      this.data[dataKey] = atom()

      this.dataConfig[dataKey].derQuerySpec = derivation(() => {
        if (!(typeof this.dataConfig[dataKey].ref == 'function')) {
          throw new Error(`${this.displayName}.data.${dataKey} querySpec must`
            + ` be a function (to be used in a derivation)`)
        }
        const querySpec = this.dataConfig[dataKey].ref()
        if (querySpec === null || querySpec === undefined) {
          return querySpec
        } else if (querySpec instanceof Array || querySpec instanceof List) {
          // [staticPathParts] or [staticPathParts..., [keys], staticPathParts...]
          if (querySpec.findIndex(pp => pp === undefined) >= 0) {
            return undefined
          } else if (querySpec.findIndex(pp => !pp) >= 0) {
            throw new Error(`Invalid path part for ${this.displayName}.data.${dataKey}:`
              + ` ${JSON.stringify(querySpec)}`
            )
          } else {
            return List(querySpec)
          }
        } else {
          // {key: [staticPathParts...]}
          return IMap(querySpec)
        }
      })

      this.dataConfig[dataKey].derQuery = derivation(() => {
        const refOptionsFunc = this.dataConfig[dataKey].refOptions

        let querySpec = this.dataConfig[dataKey].derQuerySpec.get()
        if (querySpec === null || querySpec === undefined) return querySpec

        if (querySpec instanceof Array || querySpec instanceof List) {
          const pathParts = querySpec

          // For refs with one List/Array pathPart, e.g.
          //   ['users', [123, 456], 'handle']
          // convert to multiple Firebase queries
          let multiPartIndex = -1
          for (let i = 0; i < pathParts.size; i++) {
            if (pathParts.get(i) instanceof List || pathParts.get(i) instanceof Array) {
              if (multiPartIndex >= 0) {
                throw new Error(`Can't have more than one List/Array pathPart `
                + `in ${this.displayName}.data.${dataKey}`)
              } else {
                multiPartIndex = i
              }
            } else if (typeof pathParts.get(i) != 'string') {
              throw new Error(`Invalid pathPart type at index ${i} in `
              + `${this.displayName}.data.${dataKey}: ${pathParts.get(i)}`)
            }
          }

          if (multiPartIndex == -1) {
            const rawRef = M.ref.child(pathParts.join('/'))
            return refOptionsFunc? refOptionsFunc(rawRef) : rawRef

          } else {
            const queryByKey = {}
            pathParts.get(multiPartIndex).forEach(key => {
              const keyPathParts = []
              for (let i = 0; i < pathParts.size; i++) {
                if (i == multiPartIndex) {
                  keyPathParts.push(key)
                } else {
                  keyPathParts.push(pathParts.get(i))
                }
              }
              const rawRef = M.ref.child(keyPathParts.join('/'))
              queryByKey[key] = refOptionsFunc? refOptionsFunc(key, rawRef) : rawRef
            })
            return IMap(queryByKey)
          }

        } else {
          const queryByKey = {}
          querySpec.forEach((qs, key) => {
            const rawRef = M.ref.child(qs.join('/'))
            queryByKey[key] = refOptionsFunc? refOptionsFunc(key, rawRef) : rawRef
          })
          return IMap(queryByKey)
        }
      })

      this.dataConfig[dataKey].handlers = {} // eventType: handlerByKey

      this.dataConfig[dataKey].refReactor = this.dataConfig[dataKey].derQuery.reactor(query => {
        const isMap = query instanceof IMap
        const queryByKey = query && (isMap? query : IMap({'': query}))

        const oldQueryByKey = this.dataConfig[dataKey].oldQueryByKey

        for (let eventType in this.dataConfig[dataKey].handlers) {
          const handlerByKey = this.dataConfig[dataKey].handlers[eventType]
          oldQueryByKey.forEach((oldRef, key) => {
            oldRef.off(eventType, handlerByKey[key])
          })
          delete this.dataConfig[dataKey].handlers[eventType]
        }

        this.dataConfig[dataKey].oldQueryByKey = queryByKey

        if (query === null) {
          this.data[dataKey].set(null)
        } else if (isMap) {
          const dataObj = {}
          queryByKey.forEach((ref, key) => {
            dataObj[key] = atom()
          })
          this.data[dataKey].set(IMap(dataObj))
        } else {
          this.data[dataKey].set(undefined)
        }

        if (!query) return

        for (let eventType in this.dataConfig[dataKey]) {
          if ([
            'value', 'child_added', 'child_changed', 'child_moved', 'child_removed'
          ].indexOf(eventType) >= 0) {
            this.dataConfig[dataKey].handlers[eventType] = {}

            queryByKey.forEach((ref, key) => {
              const handler = ref.on(eventType, (snapshot, prevChildKey) => {
                if (eventType == 'value' && this.dataConfig[dataKey][eventType] === true) {
                  if (isMap) {
                    this.data[dataKey].get().get(key).set(snapshot.val())
                  } else {
                    this.data[dataKey].set(snapshot.val())
                  }

                } else if (eventType == 'value' && this.dataConfig[dataKey][eventType] == 'WITH_ID') {
                  const obj = snapshot.val()
                  if (obj) obj.id = snapshot.key()
                  if (isMap) {
                    this.data[dataKey].get().get(key).set(obj)
                  } else {
                    this.data[dataKey].set(obj)
                  }

                } else if (eventType == 'value' && this.dataConfig[dataKey][eventType] == 'ID_LIST') {
                  const arr = []
                  if (snapshot.val()) {
                    snapshot.forEach(childRef => {
                      arr.push(childRef.key())
                    })
                  }
                  if (isMap) {
                    this.data[dataKey].get().get(key).set(List(arr))
                  } else {
                    this.data[dataKey].set(List(arr))
                  }

                } else if (eventType == 'value' && this.dataConfig[dataKey][eventType] == 'LIST') {
                  const arr = []
                  if (snapshot.val()) {
                    snapshot.forEach(childRef => {
                      arr.push(childRef.val())
                    })
                  }
                  if (isMap) {
                    this.data[dataKey].get().get(key).set(List(arr))
                  } else {
                    this.data[dataKey].set(List(arr))
                  }

                } else if (eventType == 'value' && this.dataConfig[dataKey][eventType] == 'LIST_WITH_IDS') {
                  const arr = []
                  if (snapshot.val()) {
                    snapshot.forEach(childRef => {
                      const childObj = childRef.val()
                      childObj.id = childRef.key()
                      arr.push(childObj)
                    })
                  }
                  if (isMap) {
                    this.data[dataKey].get().get(key).set(List(arr))
                  } else {
                    this.data[dataKey].set(List(arr))
                  }

                } else if (eventType == 'value' && this.dataConfig[dataKey][eventType] == 'MAP') {
                  const iMap = snapshot.val() && IMap(snapshot.val())
                  if (isMap) {
                    this.data[dataKey].get().get(key).set(iMap)
                  } else {
                    this.data[dataKey].set(iMap)
                  }

                } else {
                  const func = this.dataConfig[dataKey][eventType]
                  let returnValue
                  if (isMap) {
                    returnValue = this.dataConfig[dataKey][eventType](key, snapshot, prevChildKey)
                  } else {
                    returnValue = this.dataConfig[dataKey][eventType](snapshot, prevChildKey)
                  }

                  if (eventType == 'value'){
                    if (isMap) {
                      this.data[dataKey].get().get(key).set(returnValue)
                    } else {
                      this.data[dataKey].set(returnValue)
                    }
                  }
                }
              })

              this.dataConfig[dataKey].handlers[eventType][key] = handler
            })
          }
        }

        if (Object.keys(this.dataConfig[dataKey].handlers).length == 0) {
          throw new Error(`${this.displayName}.data.${dataKey} doesn't define`
          + ` any Firebase event handlers (value, child_added, child_changed,`
          + `child_moved, child_removed). One or more is required.`)
        }
      })
    }

    for (let dataKey in this.dataConfig) {
      this.dataConfig[dataKey].refReactor.start().force()
    }
  },

  componentWillReceiveProps(nextProps, nextContext) {
    // console.debug(this + ' on.props', nextContext)
    transact(() => {
      if (this.constructor.contextTypes) {
        for (let contextName in this.constructor.contextTypes) {
          this.con[contextName].set(nextContext[contextName])
        }
      }

      if (this.pro) {
        for (let propName in nextProps) {
          if (this.pro[propName]) {
            const oldDerivable = this._derivableProps[propName]

            if (oldDerivable && nextProps[propName] === oldDerivable) {
              // No-op

            } else {
              if (oldDerivable) {
                this._derivablePropReactors[propName].stop()
                delete this._derivablePropReactors[propName]
                delete this._derivableProps[propName]
              }

              if (isDerivable(this.props[propName])) {
                this._derivableProps[propName] = this.props[propName]
                this._derivablePropReactors[propName] = this.props[propName].reactor(
                  propValue => this.pro[propName].set(propValue)
                )
                this._derivablePropReactors[propName].start().force()

              } else {
                this.pro[propName].set(nextProps[propName])
              }
            }
          }
        }
      }
    })
  },

  shouldComponentUpdate() {
    if (this.debug) {
      console.debug(this + '.shouldUpdate', this._gonnaUpdate, this._$dirtyContext.get())
    }
    return this._gonnaUpdate || this._$dirtyContext.get()
  },

  componentDidMount() {
    this._mounted = true
    this.$isMounted.set(true)
  },

  componentWillUnmount() {
    if (this.debug) {
      console.debug(`${this}.componentWillUnmount`)
    }

    this._contextReactor.stop()

    // Turn off derivable prop reactors
    for (let propName in this._derivablePropReactors) {
      this._derivablePropReactors[propName].stop()
    }

    if (this.dataConfig) {
      // Turn off Firebase queries
      for (let dataKey in this.dataConfig) {
        this.dataConfig[dataKey].refReactor.stop()

        const oldQueryByKey = this.dataConfig[dataKey].oldQueryByKey

        for (let eventType in this.dataConfig[dataKey].handlers) {
          const handlerByKey = this.dataConfig[dataKey].handlers[eventType]
          for (let key in handlerByKey) {
            oldQueryByKey.get(key).off(eventType, handlerByKey[key])
          }
          delete this.dataConfig[dataKey].handlers[eventType]
        }
      }
    }

    for (let timeoutId of Object.keys(this._timeoutIds)) {
      this.clearTimeout(timeoutId)
    }
    for (let intervalIdStr of Object.keys(this._intervalIds)) {
      this.clearInterval(parseInt(intervalIdStr))
    }

    this.mRenderReactor.stop()

    this._mounted = false
    transact(() => {
      this.$isMounted.set(false)
      this.$isUnmounted.set(true)
    })
  },

  render() {
    if (this.debug) {
      console.debug(`${this}.render`)
    }
    let ret
    this._gonnaUpdate = false
    this._$dirtyContext.set(false)
    if (this._mounted && !_forceUpdateStack.length) {
      console.debug('Hot reloading ' + this)
      ret = this.mRender() // synchronously return the right thing now
      setTimeout(() => {
        // set up for returning the right thing in the future
        this._$mRender.set(this.mRender)
      })
    } else {
      ret = this.renderDerivation.get()
    }
    return ret
  },

  setTimeout(f, timeout) {
    const timeoutId = setTimeout(f, timeout)
    this._timeoutIds[timeoutId] = true
    return timeoutId
  },
  clearTimeout(timeoutId) {
    clearTimeout(timeoutId)
    delete this._timeoutIds[timeoutId]
  },
  setInterval(f, interval) {
    const intervalId = setInterval(f, interval)
    this._intervalIds[intervalId] = true
    return intervalId
  },
  clearInterval(intervalId) {
    clearInterval(intervalId)
    delete this._intervalIds[intervalId]
  },

  toString() {
    return `<${this.displayName}#${this.id}>`
  }
}

export default mixin
