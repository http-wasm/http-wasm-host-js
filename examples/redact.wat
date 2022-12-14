;; This example module is written in WebAssembly Text Format to show the
;; how a handler works and that it is decoupled from other ABI such as WASI.
;; Most users will prefer a higher-level language such as C, Rust or TinyGo.
(module $redact
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

  ;; read_body reads up to $buf_limit bytes remaining in the $kind body into
  ;; memory at offset $buf. A zero $buf_limit will panic.
  ;;
  ;; The result is `0 or EOF(1) << 32|len`, where `len` is the length in bytes
  ;; read.
  (import "http_handler" "read_body" (func $read_body
    (param $kind i32)
    (param $buf i32) (param $buf_len i32)
    (result (; 0 or EOF(1) << 32 | len ;) i64)))

  ;; write_body reads $buf_len bytes at memory offset `buf` and writes them to
  ;; the pending $kind body.
  (import "http_handler" "write_body" (func $write_body
    (param $kind i32)
    (param $buf i32) (param $buf_len i32)))

  ;; http_handler guests are required to export "memory", so that imported
  ;; functions like $read_body can read memory.
  (memory (export "memory") 1 1 (; 1 page==64KB ;))

  ;; eof is the upper 32-bits of the $read_body result on EOF.
  (global $eof i64 (i64.const 4294967296)) ;; `1<<32|0`

  ;; body is the memory offset past any initialization data.
  (global $body i32 (i32.const 1024))

  (global $secret i32 (i32.const 0))
  ;; $secret_len is mutable as it is initialized during start.
  (global $secret_len (mut i32) (i32.const 0))

  ;; read_secret ensures there's a non-zero length secret configured.
  (func $read_secret
    (local $config_len i32)

    (local.set $config_len
      (call $get_config (global.get $secret) (global.get $body)))

    ;; if config_len > body { panic }
    (if (i32.gt_u (local.get $config_len) (global.get $body))
      (then unreachable))

    ;; secret_len = config_len
    (global.set $secret_len (local.get $config_len))

    ;; if secret_len == 0 { panic }
    (if (i32.eqz (global.get $secret_len))
      (then unreachable)))

  ;; required_features := feature_buffer_request|feature_buffer_response
  (global $required_features i32 (i32.const 3))

  ;; enable_buffering ensures we can inspect request and response bodies
  ;; without interfering with the next handler.
  (func $enable_buffering
    (local $enabled_features i32)

    ;; enabled_features := enable_features(required_features)
    (local.set $enabled_features
      (call $enable_features (global.get $required_features)))

    ;; if enabled_features&required_features == 0 { panic }
    (if (i32.eqz (i32.and
          (local.get $enabled_features)
          (global.get $required_features)))
      (then unreachable)))

  (func $_start (export "_start")
    (call $enable_buffering)
    (call $read_secret))

  ;; must_read_body reads and returns the length of the body of the given $kind
  ;; or fails if out of memory.
  (func $must_read_body (param $kind i32) (result (; len ;) i32)
    (local $limit  i32)
    (local $result i64)
    (local $len    i32)

    ;; set limit to the amount of available memory without growing.
    (local.set $limit (i32.sub
      (i32.mul (memory.size) (i32.const 65536))
      (global.get $body)))

    ;; result = read_body(kind, body, limit)
    (local.set $result
      (call $read_body
        (local.get $kind)
        (global.get $body) (local.get $limit)))

    ;; len = uint32(result)
    (local.set $len (i32.wrap_i64 (local.get $result)))

    ;; if result & eof != eof { panic }
    (if (i64.ne
          (i64.and (local.get $result) (global.get $eof))
          (global.get $eof))
      (then unreachable)) ;; fail as we couldn't buffer the whole response.

    (local.get $len))

  ;; handle_request redacts any request body.
  (func (export "handle_request") (result (; ctx_next ;) i64)
    (local $len i32)

    ;; load the request body from the upstream handler into memory.
    (local.set $len (call $must_read_body (i32.const 0)))

    ;; if redaction affected the copy of the request in memory...
    (if (call $redact (global.get $body) (local.get $len))
      (then ;; overwrite the request body on the host with the redacted one.
        (call $write_body
          (i32.const 0) ;; body_kind_request
          (global.get $body) (local.get $len))))

    ;; uint32(ctx_next) == 1 means proceed to the next handler on the host.
    (return (i64.const 1)))

  ;; handle_response redacts any request body.
  (func (export "handle_response") (param $reqCtx i32) (param $is_error i32)
    (local $len i32)

    (if (i32.eq (local.get $is_error) (i32.const 1))
      (then (return))) ;; nothing to redact on error

    ;; load the response body from the downstream handler into memory.
    (local.set $len (call $must_read_body (i32.const 1)))

    ;; if redaction affected the copy of the response in memory...
    (if (call $redact (global.get $body) (local.get $len))
      (then ;; overwrite the response body on the host with the redacted one.
        (call $write_body
          (i32.const 1) ;; body_kind_response
          (global.get $body) (local.get $len)))))

  ;; redact inline replaces any secrets in the memory region with hashes (#).
  (func $redact (param $ptr i32) (param $len i32) (result (; redacted ;) i32)
    (local $redacted i32)

    (if (i32.eqz (call $can_redact (local.get $len)))
      (then (return (i32.const 0)))) ;; can't redact

    (loop $redacting
      ;; if mem[i:secret_len] == secret
      (if (call $memeq (local.get $ptr) (global.get $secret) (global.get $secret_len))
        (then ;; redact by overwriting the region with hashes (#)
          (local.set $redacted (i32.const 1))
          (memory.fill
            (local.get $ptr)
            (i32.const 35) ;; # in ASCII
            (global.get $secret_len))))

      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1))) ;; ptr++
      (local.set $len (i32.sub (local.get $len) (i32.const 1))) ;; $len--

      ;; if can_redact(len) { continue } else { break }
      (br_if $redacting (call $can_redact (local.get $len))))

    ;; return whether the memory changed due to redaction
    (local.get $redacted))

  ;; can_redact ensures the current pointer can be compared to the secret.
  (func $can_redact (param $len i32) (result (; ok ;) i32)
    (i32.and
      (i32.gt_u (global.get $secret_len) (local.get $len)
      (i32.gt_u (local.get $len) (i32.const 0)))))

  ;; memeq is like memcmp except it returns 0 (ne) or 1 (eq)
  (func $memeq (param $ptr1 i32) (param $ptr2 i32) (param $len i32) (result i32)
    (local $i1 i32)
    (local $i2 i32)
    (local.set $i1 (local.get $ptr1)) ;; i1 := ptr1
    (local.set $i2 (local.get $ptr2)) ;; i2 := ptr1

    (loop $len_gt_zero
      ;; if mem[i1] != mem[i2]
      (if (i32.ne (i32.load8_u (local.get $i1)) (i32.load8_u (local.get $i2)))
        (then (return (i32.const 0)))) ;; return 0

      (local.set $i1  (i32.add (local.get $i1)  (i32.const 1))) ;; i1++
      (local.set $i2  (i32.add (local.get $i2)  (i32.const 1))) ;; i2++
      (local.set $len (i32.sub (local.get $len) (i32.const 1))) ;; $len--

      ;; if $len > 0 { continue } else { break }
      (br_if $len_gt_zero (i32.gt_u (local.get $len) (i32.const 0))))

    (i32.const 1)) ;; return 1
)
