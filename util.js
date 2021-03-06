import moment from 'moment'

import M from './m'

module.exports = {
  alertError: (err) => {
    // TODO: Show a modal dialogue
    // alert(err.message)
    console.error(err)
  },

  compare: (a, b) => {
    return M.util.makeComparator(x => {
      if (x instanceof String) {
        return x.toUpperCase()
      } else {
        return x
      }
    })(a, b)
  },

  formatMessengerDate: (date) => {
    date = moment(date)
    const now = moment()

    if (now.diff(date, 'hours') <= 11) {
      return date.format('h:mma')
    } else if (now.diff(date, 'days') <= 5) {
      return date.format('ddd')
    } else {
      return date.format('MMM D')
    }
  },

  log() {
    const args = []
    for (arg of arguments) {
      args.push(M.util.toLoggable(arg))
    }
    return console.log.apply(console, args)
  },

  logChanges(preamble, derivable) {
    if (!derivable) {
      derivable = preamble
      preamble = '[derivable value]'
    }
    derivable.react(value => {
      M.util.log(preamble, value)
    })
  },

  makeComparator: (keyFunc, reverse) => {
    return (a, b) => {
      if (reverse) {
        const temp = a
        a = b
        b = temp
      }
      const aKey = keyFunc(a)
      const bKey = keyFunc(b)
      if (aKey instanceof Array && bKey instanceof Array) {
        for (let i = 0; i < aKey.length; i++) {
          if (aKey[i] < bKey[i]) {
            return -1
          } else if (bKey[i] < aKey[i]) {
            return 1
          }
        }
        return 0
      } else {
        if (aKey < bKey) {
          return -1
        } else if (bKey < aKey) {
          return 1
        } else {
          return 0
        }
      }
    }
  },

  makeSlug: str => {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  },

  makeUrl: (pathParams, queryParams) => {
    let url = '/' + (pathParams || []).join('/')
    const queryParamsStr = M.util.objToParamString(queryParams)
    if (queryParamsStr) {
      url += '?' + queryParamsStr
    }
    return url
  },

  mod: (a, b) => {
    // Like a % b but behaves properly when a is negative
    return ((a % b) + b) % b
  },

  objToParamString: obj => {
    let str = ""
    for (let key in obj) {
      if (obj[key] == null) continue

      if (str != "") {
        str += "&"
      }
      str += key + "=" + encodeURIComponent(obj[key])
    }
    return str
  },

  shuffle: arr => {
    // http://stackoverflow.com/questions/6274339/how-can-i-shuffle-an-array-in-javascript
    const stackOverflowShuffleFunc = function shuffle(o){
      for(var j, x, i = o.length; i; j = Math.floor(Math.random() * i), x = o[--i], o[i] = o[j], o[j] = x);
      return o;
    }
    stackOverflowShuffleFunc(arr)
  },

  toLoggable: x => {
    if (x && x.toJS) {
      return x.toJS()
    } else {
      return x
    }
  },

  urlRegex: /((?:https?:\/\/)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b(?:[-a-zA-Z0-9@:%_\+.~#?&//=]*))/
}
