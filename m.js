'use strict'

import immutable, {List, Map as IMap} from 'immutable'
import {atom, derivation, lens, transact} from 'derivable'
import queryString from 'query-string'
import Firebase from 'firebase'
import Fireproof from 'fireproof'
import md5 from 'md5'
import React, {
  AsyncStorage,
  PushNotificationIOS
} from 'react-native'

import util from './util'
import mixin from './mixin'

const MReact = Object.assign({}, React)
MReact.createClass = componentSpec => {
  if (!componentSpec.displayName) {
    throw new Error(`componentSpec missing displayName`)
  }
  if (!(componentSpec.mixins && componentSpec.mixins[0] == M.mixin)) {
    throw new Error(`componentSpec missing M.mixin`)
  }
  const reactSpec = Object.assign({}, componentSpec)
  reactSpec.mRender = componentSpec.render
  delete reactSpec.render
  return React.createClass(reactSpec)
}

const M = {
  mixin,
  util
}

Object.assign(M, {
  _refs: {},

  $appState: atom(null),
  $badgeNumber: atom(),

  context: {
    deviceToken: atom(),
    isAdmin: derivation(() => {
      if (M.context.uid.get() === undefined || M.context.user.get() === undefined) {
        return undefined
      } else {
        return !!(M.context.user.get() && M.context.user.get().isAdmin)
      }
    }),
    keyboardHeight: atom(0),
    sessionId: atom(),
    showingStatusBar: atom(true),
    statusBarHeight: atom(),
    uid: atom(),
    user: atom()
  },

  init (config) {
    M.config = Object.assign({}, config)
    M.colors = config.colors
    const firebase = (config.firebaseAppName?
      new Firebase(`https://${config.firebaseAppName}.firebaseio.com`) :
      null
    )
    M.ref = firebase && new Fireproof(firebase)
  },

  c (componentName, componentSpec) {
    return MReact.createClass(Object.assign(
      {displayName: componentName},
      componentSpec
    ))
  },

  contextDer: derivation(() => {
    const contextValues = {}
    for (let contextName in M.context) {
      contextValues[contextName] = M.context[contextName].get()
    }
    return IMap(contextValues)
  }),

  defaultAtom (defaultValue) {
    return atom().lens({
      get: value => value === undefined? defaultValue : value,
      set: (oldValue, value) => value
    })
  },

  listAtom (defaultValue) {
    const defaultList = defaultValue? List(defaultValue) : defaultValue

    return atom().lens({
      get: value => value === undefined? defaultList : value,
      set: (oldValue, value) => value? List(value) : value
    })
  },

  mapAtom (defaultValue) {
    const defaultMap = defaultValue? IMap(defaultValue) : defaultValue

    return atom().lens({
      get: value => value === undefined? defaultMap : value,
      set: (oldValue, value) => value? IMap(value) : value
    })
  },

  mergeAtom (defaultValue, deep = true) {
    defaultValue = immutable.fromJS(defaultValue)
    if (defaultValue === undefined) {
      defaultValue = IMap({})
    } else if (!(defaultValue instanceof IMap)) {
      throw new Error(`mergeAtom defaultValue must be IMap, object or undefined`)
    }
    return atom(defaultValue).lens({
      get: value => value,
      set: (oldValue, value) => {
        if (value == null) {
          return oldValue
        } else if (value) {
          if (deep) {
            return defaultValue.mergeDeep(value)
          } else {
            return defaultValue.merge(value)
          }
        }
      }
    })
  },

  requiredAtom () {
    return atom().lens({
      get: value => value,
      set (oldValue, value) {
        if (value == null) {
          throw new Error("requiredAtom got value " + value)
        }
        return value
      }
    })
  },

  apiCall: (endpoint, options) => {
    options = Object.assign({}, options)

    options.params = Object.assign({}, options.params)
    if (M.context.sessionId.get()) {
      options.params.sessionId = M.context.sessionId.get()
    }

    let url = M.config.apiBaseUrl + endpoint
    if (options.params) {
      if (options.method == 'post') {
        options.body = JSON.stringify(options.params)
      } else {
        url += '?' + M.util.objToParamString(options.params)
      }
      delete options.params
    }

    return fetch(url, options).then(apiResponse => {
      if (apiResponse.ok) {
        return apiResponse.json()
      } else {
        throw new Error(`${apiResponse.status}: ${apiResponse.statusText}`)
      }
    }).then(apiResponseJson => {
      if (apiResponseJson && apiResponseJson.err) {
        const err = new Error(apiResponseJson.err)
        err.id = apiResponseJson.errId || null
        throw err
      } else {
        return apiResponseJson
      }
    })
  },

  apiGet: (endpoint, params = {}) => {
    return M.apiCall(endpoint, {params})
  },

  apiPost: (endpoint, params = {}) => {
    return M.apiCall(endpoint, {
      method: 'post',
      headers: {
        'Content-Type': "application/json"
      },
      params
    })
  },

  async ensureSession() {
    // Init existing session from AsyncStorage
    M.context.sessionId.set(await AsyncStorage.getItem('sessionId'))
    M.context.uid.set(await AsyncStorage.getItem('uid'))
    let firebaseToken = await AsyncStorage.getItem('firebaseToken')
    if (firebaseToken) {
      try {
        await M.ref.authWithCustomToken(firebaseToken)
      } catch (ex) {
        console.log('Firebase auth failed (probably token expired)', ex)
      }
    }

    if (M.context.sessionId.get()) {
      const session = await M.apiGet('session')

      if (session && session.uid) {
        const firebaseAuth = M.ref.getAuth()
        if (firebaseAuth && firebaseAuth.uid == session.uid) {
          M.context.uid.set(session.uid)
          M.ref.onAuth(authData => {
            if (!authData && M.context.uid.get()) {
              // At some later time, the Firebase auth token has expired
              console.log(`Logging out because the Firebase token has expired`)
              M.logout()
            }
          })

        } else {
          // Apparently we're logged into the API but not into
          // Firebase. Just log out to restore a consistent state
          // (and start a new session)
          await M.logout()
        }
      } else {
        M.context.uid.set(null)
      }

    } else {
      await M.startNewSession()
    }
  },

  async startNewSession() {
    const session = await M.apiPost('newSession')
    transact(() => {
      M.context.sessionId.set(session.id)
      M.context.uid.set(session.uid)
    })
  },

  async logout() {
    const apiPromise = M.apiPost('logout')

    transact(() => {
      M.context.uid.set(null)
      M.context.sessionId.set(undefined)
      M.context.user.set(null)
    })
    await M._setFirebaseToken(null)
    ref.unauth()

    let apiResponse
    try {
      apiResponse = await apiPromise
    } catch (err) {
      console.error("Error during logout", err)
    }
    if (apiResponse) {
      M.context.sessionId.set(apiResponse.newSessionId)
    }
  },

  async _setFirebaseToken(firebaseToken) {
    if (firebaseToken) {
      await AsyncStorage.setItem('firebaseToken', firebaseToken)
    } else {
      await AsyncStorage.removeItem('firebaseToken')
    }
  }
})

M.context.sessionId.react(async function() {
  if (M.context.sessionId.get()) {
    await AsyncStorage.setItem('sessionId', M.context.sessionId.get())
  } else {
    await AsyncStorage.removeItem('sessionId')
  }
}, {skipFirst: true})

M.context.uid.react(async function() {
  if (M.context.uid.get()) {
    await AsyncStorage.setItem('uid', M.context.uid.get())
  } else {
    await AsyncStorage.removeItem('uid')
  }
}, {skipFirst: true})


derivation(() => List([
  M.context.deviceToken.get(),
  M.context.sessionId.get()
])).react(() => {
  if (M.context.deviceToken.get() && M.context.sessionId.get()) {
    M.apiPost('registerDeviceToken', {
      deviceToken: M.context.deviceToken.get()
    })
  }
})
PushNotificationIOS.addEventListener('register', deviceToken => {
  M.context.deviceToken.set(deviceToken)
})
PushNotificationIOS.requestPermissions()


export default M
export {MReact as React}
