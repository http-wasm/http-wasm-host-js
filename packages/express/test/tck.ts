import util from 'node:util';
import { execFile as nodeExecFile } from 'node:child_process';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';

import { after } from 'mocha';
import express from 'express';
import { GenericContainer, TestContainers } from 'testcontainers';
import { assert } from 'chai';

import httpwasm from '../index.js';

const execFile = util.promisify(nodeExecFile);

const tckImage = 'ghcr.io/http-wasm/http-wasm-tck:sha-e25f1a2';

describe('tck', async function () {
  let server: http.Server;
  let port: number;

  before(async function () {
    const wasmPath = path.resolve('..', '..', 'build', 'tck.wasm');

    const tck = await new GenericContainer(tckImage)
      .withCommand(['extract-guest', '/out/tck.wasm'])
      .withBindMounts([
        {
          source: path.resolve('..', '..', 'build'),
          target: '/out',
          mode: 'rw',
        },
      ])
      .start();

    const app = express();
    const mw = await httpwasm({ wasmPath });
    app.use(mw);

    app.all('/*', (req, res) => {
      res.setHeader('x-httpwasm-next-method', req.method);
      res.setHeader('x-httpwasm-next-uri', req.url);
      req.headers;
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value) {
          continue;
        }
        const values = Array.isArray(value) ? value : [value];
        for (let i = 0; i < values.length; i++) {
          res.setHeader(`x-httpwasm-next-header-${key}-${i}`, values[i]);
        }
      }
      res.sendStatus(200);
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => resolve(undefined));
    });

    const address = server.address() as AddressInfo;
    port = address.port;
  });

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

  it('passes', async function () {
    await TestContainers.exposeHostPorts(port);
    console.log(port);

    const tck = await new GenericContainer(tckImage)
      .withCommand([
        'run',
        '-url',
        `http://host.testcontainers.internal:${port}`,
      ])
      .withNetworkMode('host')
      .start();

    let failed = false;
    const logs = await tck.logs();
    await new Promise((resolve, reject) => {
      logs
        .on('data', (line: string) => {
          console.log(line.trimEnd());
          if (line.includes('FAIL')) {
            failed = true;
          }
        })
        .on('err', (line: string) => {
          console.error(line.trimEnd());
        })
        .on('end', () => {
          resolve(true);
        });
    });

    assert.isFalse(failed);
  }).timeout(10000);
});
