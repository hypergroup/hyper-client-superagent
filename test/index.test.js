/**
 * Module dependencies
 */

var should = require('should');
var Client = require('..');

describe('hyper-client-superagent', function() {
  var client;
  beforeEach(function() {
    client = new Client('https://www.qzzr.com/api');
  });

  it('should work', function(done) {
    client.root(function(err, res) {
      console.log(res);
    });

    client.root(function(err, res) {
      console.log(res);
      done();
    });
  });
});
