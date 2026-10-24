;; The source of `add.wasm`, kept so the binary next to it is readable rather than magic.
;; It is the module Next.js's own compatibility test uses (`test/e2e/edge-can-use-wasm-files`):
;; one exported function, no imports, no memory — nothing but proof that the module reached the
;; Worker compiled and could be instantiated there.
;;
;; The 44 bytes were hand-encoded, so there is no toolchain to install to rebuild them:
;;   magic/version, a type section (i32) -> i32, a function section, an export section naming
;;   `add_one`, and a code section of `local.get 0; i32.const 1; i32.add`.
(module
  (func $add_one (param $n i32) (result i32)
    local.get $n
    i32.const 1
    i32.add)
  (export "add_one" (func $add_one)))
