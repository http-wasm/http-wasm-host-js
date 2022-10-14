import { AddressInfo } from 'node:net';
import http from 'node:http';

import { assert } from 'chai';
import express, { Request, Response } from 'express';
import { after, describe, it } from 'mocha';
import fetch from 'node-fetch';

import httpwasm from '../index.js';

const requestBody = '{"hello": "panda"}';
const responseBody = '{"hello": "world"}';

const serveJson = (req: Request, res: Response) => {
  res.contentType('application/json').send(responseBody);
};

const servePath = (req: Request, res: Response) => {
  res.contentType('text/plain').send(req.url);
};

describe('auth middleware', async function () {
  const wasmPath = '../../testdata/examples/auth.wasm';

  let server: http.Server;
  let url: string;

  before(async function () {
    // Initialize the express server.
    const app = express();

    // Configure and compile the WebAssembly guest binary. In this case,
    // it is an auth interceptor.
    const mw = await httpwasm({ wasmPath });

    // Register the middleware with the express server.
    app.use(mw);

    // Register the real request handler.
    app.get('/*', serveJson);

    // Start the server and wait for it to be ready.
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  // Shutdown server after tests finish.
  after(async function () {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
  });

  it('no header', async function () {
    const response = await fetch(url);
    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get('www-authenticate'),
      'Basic realm="test"',
    );
  });

  it('empty header', async function () {
    const response = await fetch(url, {
      headers: { Authorization: '' },
    });
    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get('www-authenticate'),
      'Basic realm="test"',
    );
  });

  it('valid header', async function () {
    const response = await fetch(url, {
      headers: { Authorization: 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==' },
    });
    assert.equal(response.status, 200);
    const content = await response.text();
    assert.equal(content, responseBody);
  });

  it('invalid header', async function () {
    const response = await fetch(url, {
      headers: { Authorization: '0' },
    });
    assert.equal(response.status, 401);
    assert.notExists(response.headers.get('www-authenticate'));
  });
});

describe('router middleware', async function () {
  const wasmPath = '../../testdata/examples/router.wasm';

  let server: http.Server;
  let url: string;

  before(async function () {
    // Initialize the express server.
    const app = express();

    // Configure and compile the WebAssembly guest binary. In this case,
    // it is an auth interceptor.
    const mw = await httpwasm({ wasmPath });

    // Register the middleware with the express server.
    app.use(mw);

    // Register the real request handler.
    app.get('/*', servePath);

    // Start the server and wait for it to be ready.
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  // Shutdown server after tests finish.
  after(
    () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve(undefined);
          }
        });
      }),
  );

  it('/', async function () {
    const response = await fetch(`${url}${this.test!.title}`);
    const content = await response.text();
    assert.equal(content, 'hello world');
  });

  it('/nothosst', async function () {
    const response = await fetch(`${url}${this.test!.title}`);
    const content = await response.text();
    assert.equal(content, 'hello world');
  });

  it('/host/a', async function () {
    const response = await fetch(`${url}${this.test!.title}`);
    const content = await response.text();
    assert.equal(content, '/a');
  });

  it('/host/b?name=panda', async function () {
    const response = await fetch(`${url}${this.test!.title}`);
    const content = await response.text();
    assert.equal(content, '/b?name=panda');
  });
});
