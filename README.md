[![Build](https://github.com/http-wasm/http-wasm-host-js/workflows/build/badge.svg)](https://github.com/http-wasm/http-wasm-host-js)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

# http-wasm Host Library for JS

[http-wasm][1] defines HTTP functions implemented in [WebAssembly][2]. This
repository includes [http-handler ABI][3] middleware for various HTTP server
libraries written in JavaScript.

* [express](packages/express): [Express][4]

# WARNING: This is a proof of concept!

The current maturity phase is proof of concept. We will go back and revisit things 
intentionally deferred after initial implementations settle down.

Meanwhile, minor details and test coverage will fall short of production
standards. This helps us deliver the proof-of-concept faster and prevents
wasted energy in the case that the concept isn't acceptable at all.

[1]: https://github.com/http-wasm
[2]: https://webassembly.org/
[3]: https://http-wasm.io/http-handler-abi/
[4]: https://expressjs.com/
