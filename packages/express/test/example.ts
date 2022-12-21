import { AddressInfo } from 'node:net';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileHandle } from 'fs/promises';

import { assert } from 'chai';
import express, { Request, Response } from 'express';
import { after, describe, it } from 'mocha';
import fetch from 'node-fetch';
import getRawBody from 'raw-body';
import { stub } from 'sinon';

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
  const wasmPath = '../../examples/auth.wasm';

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
    app.all('/*', serveJson);

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

describe('log middleware', async () => {
  const wasmPath = '../../examples/log.wasm';

  let server: http.Server;
  let url: string;

  before(async () => {
    // Initialize the express server.
    const app = express();

    // Configure and compile the WebAssembly guest binary. In this case,
    // it is an auth interceptor.
    const mw = await httpwasm({ wasmPath });

    // Register the middleware with the express server.
    app.use(mw);

    // Avoid adding express middleware to collect body to make sure
    // httpwasm middleware does not rely on it.

    // Register the real request handler.
    app.all('/*', serveJson);

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

  it('logs', async () => {
    const spy = stub(console, 'info');

    const response = await fetch(url);
    const content = await response.text();
    assert.equal(content, responseBody);

    assert.isTrue(spy.calledWith('hello world'));
  });
});

describe('router middleware', async function () {
  const wasmPath = '../../examples/router.wasm';

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
    app.all('/*', servePath);

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

describe('redact middleware', async function () {
  const wasmPath = '../../examples/redact.wasm';

  const secret = 'open sesame';

  let server: http.Server;
  let url: string;
  let rawBody: string;
  let readReqBody: string;

  before(async function () {
    // Initialize the express server.
    const app = express();

    // Configure and compile the WebAssembly guest binary. In this case,
    // it is an auth interceptor.
    const mw = await httpwasm({ wasmPath, config: Buffer.from(secret) });

    // Register the middleware with the express server.
    app.use(mw);

    // Register the real request handler.
    app.all('/*', async (req, res) => {
      readReqBody = req.body ? req.body : await getRawBody(req);
      res.contentType('text/plain').send(rawBody);
    });

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

  it(secret, async function () {
    rawBody = this.test!.title;
    const response = await fetch(url, {
      method: 'POST',
      body: rawBody,
    });
    const content = await response.text();
    assert.equal(content, '###########');
    assert.equal(readReqBody, '###########');
  });

  it('hello world', async function () {
    rawBody = this.test!.title;
    const response = await fetch(url, {
      method: 'POST',
      body: rawBody,
    });
    const content = await response.text();
    assert.equal(content, 'hello world');
    assert.equal(readReqBody, 'hello world');
  });

  it(`hello ${secret} world`, async function () {
    rawBody = this.test!.title;
    const response = await fetch(url, {
      method: 'POST',
      body: rawBody,
    });
    const content = await response.text();
    assert.equal(content, 'hello ########### world');
    assert.equal(readReqBody, 'hello ########### world');
  });
});

describe('wasi middleware', async function () {
  const wasmPath = '../../examples/wasi.wasm';

  let server: http.Server;
  let url: string;
  let tempDir: string;
  let logPath: string;
  let logFile: FileHandle;

  before(async function () {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasi-'));
    logPath = path.join(tempDir, 'log.txt');
    logFile = await fs.open(logPath, 'w');

    // Initialize the express server.
    const app = express();

    // Configure and compile the WebAssembly guest binary. In this case,
    // it is an auth interceptor.
    const mw = await httpwasm({ wasmPath, wasi: { stdout: logFile.fd } });

    // Register the middleware with the express server.
    app.use(mw);

    // Register the real request handler.
    app.all('/*', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', ['a=b', 'c=d']);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Date', 'Tue, 15 Nov 1994 08:12:31 GMT');

      res.setHeader('Trailer', 'grpc-status');
      res.writeHead(200);
      res.write(responseBody);
      res.addTrailers({ 'grpc-status': '1' });
      res.end();
    });

    // Start the server and wait for it to be ready.
    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  // Shutdown server after tests finish.
  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(undefined);
        }
      });
    });
    await logFile.close();
    await fs.rm(tempDir, { recursive: true });
  });

  it('should log request / response', async function () {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost',
      },
      body: requestBody,
    });
    const content = await response.text();
    assert.equal(content, responseBody);

    const log = await fs.readFile(logPath);
    assert.equal(
      log.toString().trim(),
      `
POST / HTTP/1.1
accept: */*
accept-encoding: gzip
accept-encoding: deflate
accept-encoding: br
connection: close
content-length: 18
content-type: application/json
host: localhost
user-agent: node-fetch

{"hello": "panda"}

HTTP/1.1 200
x-powered-by: Express
content-type: application/json
set-cookie: a=b
set-cookie: c=d
transfer-encoding: chunked
date: Tue, 15 Nov 1994 08:12:31 GMT
trailer: grpc-status

{"hello": "world"}
grpc-status: 1
    `.trim(),
    );
  });
});
