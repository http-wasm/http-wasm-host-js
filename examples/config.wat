;; This example module is written in WebAssembly Text Format to show the
;; how a handler works and that it is decoupled from other ABI such as WASI.
;; Most users will prefer a higher-level language such as C, Rust or TinyGo.
(module $config
  ;; enable_features tries to enable the given features and returns the entire
  ;; feature bitflag supported by the host.
  (import "http_handler" "enable_features" (func $enable_features
    (param $enable_features i32)
    (result (; enabled_features ;) i32)))

  ;; get_config writes configuration from the host to memory if it exists and
  ;; isn't larger than $buf_limit. The result is its length in bytes.
  (import "http_handler" "get_config" (func $get_config
    (param $buf i32) (param $buf_limit i32)
    (result (; len ;) i32)))

  ;; handle_request just calls next by returning non-zero.
  (func (export "handle_request") (result (; ctx_next ;) i64)
    ;; uint32(ctx_next) == 1 means proceed to the next handler on the host.
    (return (i64.const 1)))

  ;; handle_response is no-op as this is a request-only handler.
  (func (export "handle_response") (param $reqCtx i32) (param $is_error i32))

  ;; http_handler guests are required to export "memory", so that imported
  ;; functions like "get_header" can read memory.
  (memory (export "memory") 1 1 (; 1 page==64KB ;))

  (func $must_enable_features
    (local $config_len i32)
    (local $required_features i32)
    (local $enabled_features i32)

    (local.set $config_len
      (call $get_config (i32.const 0) (i32.const 8)))

    ;; if config_len != size_of_uint64le { panic }
    (if (i32.ne (local.get $config_len) (i32.const 8))
      (then unreachable))

    (local.set $required_features (i32.load (i32.const 0)))

    ;; enabled_features := enable_features(required_features)
    (local.set $enabled_features
      (call $enable_features (local.get $required_features)))

    ;; if required_features == 0
    (if (i32.eqz (local.get $required_features))
      ;; if enabled_features != 0 { panic }
      (then (if (i32.ne
          (local.get $enabled_features)
          (i32.const 0))
        (then unreachable)))
      ;; else if enabled_features&required_features == 0 { panic }
      (else (if (i32.eqz (i32.and
          (local.get $enabled_features)
          (local.get $required_features)))
        (then unreachable)))))

  (start $must_enable_features)
)
