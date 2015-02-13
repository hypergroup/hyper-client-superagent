/**
 * Module dependencies
 */

var superagent = require('superagent-defaults');
var LRU = require('lru-cache');
var immutableParse = require('hyper-json-immutable-parse');
var inherits = require('util').inherits;
var Emitter = require('events').EventEmitter;

/**
 * Expose the Client constructor
 */

module.exports = Client;

/**
 * Create a client
 */

function Client(API_URL, opts) {
  if (!(this instanceof Client)) return new Client(API_URL, opts);

  Emitter.call(this);
  var self = this;
  opts = opts || {};
  self.cache = new LRU(opts.maxSize || 500);
  self.pending = {};

  self.root = get.bind(self, API_URL);
  self.get = get.bind(self);

  var context = self.context = superagent();

  // TODO only set the parser for the context
  var parsers = context.request.parse;
  parsers['application/json'] = parsers['application/hyper+json'] = parseHyperJson;

  patchCrappySuperagent(context.request.Response, context.request.parse);
}
inherits(Client, Emitter);

Client.prototype.auth = function(user, pass) {
  this.context.auth(user, pass);
  return this;
};

Client.prototype.use = function(fn) {
  this.context.on('request', fn);
  return this;
};

Client.prototype.header = function(key, value) {
  this.context.set(key, value);
  return this;
};

Client.prototype.submit = function(method, action, body, fn) {
  var self = this;
  method = method.toLowerCase();
  var req = self._init(method, action);

  if (body) {
    method === 'get' ?
      req.query(body) :
      req.send(body);
  }

  req.end(function(err, res) {
    if (err) return fn(err);
    if (!res.ok) return fn(new HyperError(res));
    var location = res.get('location');
    var contentLocation = res.get('content-location');
    var href = contentLocation || location;
    var body = res.body;
    if (method !== 'get') {
      if (body && body.href) self.refresh(body.href, body, body.links);
      if (contentLocation) self.refresh(contentLocation, res.body, body.links);
      if (location) self.refresh(location);
      // TODO http://tools.ietf.org/html/draft-nottingham-linked-cache-inv-03#section-3
    }
    fn(null, res.body, res.links, href, false);
  });
};

Client.prototype.refresh = function(href, body, links) {
  if (body) this._save(href, body, links);
  this._bustCache(href);
};

Client.prototype.subscribe = function(href, cb) {
  var self = this;
  var sub = function() {
    cb.apply(self, arguments);
  };
  self.on(href, sub);
  return function() {
    self.removeEventListener(sub);
  };
};

Client.prototype._save = function(href, body, links) {
  this.cache.set(href, {b: body, l: links});
  this.emit(href, null, body, links, null, false);
};

Client.prototype._bustCache = function(href) {
  var req = this._fetch(href);
  req.set({
    'cache-control': 'max-age=0, no-store, no-cache',
    pragma: 'no-cache'
  });
  req.end();
};

Client.prototype._init = function(method, href) {
  if (process.env.CHAOS) {
    var weight = parseFloat(process.env.CHAOS);
    if (isNaN(weight)) weight = 0.1;
    if (Math.random() < weight) return chaos(href);
  }
  return this.context[method](href);
};

Client.prototype._fetch = function(href, cb) {
  var self = this;
  var pending = self.pending;
  var req = pending[href] = self._init('get', href);

  self._wait(href, function(err, body, links) {
    delete pending[href];

    if (err) return;

    self._save(href, body, links);

    setTimeout(function() {
      req.removeAllListeners();
    }, 0);
  }, false);

  if (!cb) return req;

  var sub = self._wait(href, cb);

  req.end();

  return sub;
};

Client.prototype._wait = function(href, cb, shouldSubscribe) {
  var self = this;

  var req = self.pending[href];
  if (!req) return false;

  req.on('error', cb);

  if (shouldSubscribe !== false) return self.subscribe(href, cb);

  req.on('response', function(res) {
    if (res.error) return cb(res.error);
    return cb(null, res.body, res.links, null, false);
  });
  return req;
};

function get(href, cb) {
  var self = this;
  var cache = self.cache;
  var res = cache.get(href);
  if (res) return cb(null, res.b, res.l, null, false);

  return self._wait(href, cb) || self._fetch(href, cb);
}

function parseHyperJson(res, fn) {
  // browser
  if (typeof res === 'string') return parseJSON(res, this.xhr.responseURL || this.headers['content-location'] || this.headers.location || this.req.url);

  // node
  res.text = '';
  res.setEncoding('utf8');
  res.on('data', function(chunk){ res.text += chunk; });
  res.on('end', function(){
    var href = res.headers['content-location'] || res.headers['location'] || res.req.url;
    var out;
    try {
      out = parseJSON(res.text.replace(/^\s*|\s*$/g, ''), href);
    } catch (err) {
      return fn(err);
    }
    return fn(null, out);
  });
}

function parseJSON(body, href) {
  return JSON.parse(body, immutableParse(href));
}

if (process.env.CHAOS) {

  function chaos(path) {
    var req = new Emitter();
    if (Math.random() > 0.5) {
      setTimeout(function() {
        req.emit('error', new Error('Internal server error'));
      }, Math.random() * 500);
    } else {
      setTimeout(function() {
        req.emit('error', new Error('Connection timeout'));
      }, 5000);
    }
    req.end = function() {};
    return req;
  }
}

/**
 * Create a hyper error given a superagent response
 *
 * @param {Response} res
 */

function HyperError(res) {
  Error.call(this);
  Error.captureStackTrace(this, arguments.callee);
  this.name = 'HyperError';
  this.status = res.status;
  if (res.body && res.body.error) this.message = res.body.error.message;
  else this.message = res.text;
}

function patchCrappySuperagent(Response, parsers) {
  if (!Response || !Response.prototype.parseBody) return;
  Response.prototype.parseBody = function(str) {
    var parse = parsers[this.type];
    return parse && str && str.length ?
      parse.call(this, str) :
      null;
  };
}
