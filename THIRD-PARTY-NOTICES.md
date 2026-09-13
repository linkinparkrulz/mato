# Third-party notices

The Dojo Bay's own code is MIT-licensed ([LICENSE](LICENSE)). It depends on
software under other licences, two of which are copyleft, and this file records
what they are and the rule that keeps the arrangement honest.

## LGPL-3.0 components

Both come from the [Dojo Open Source
Project](https://github.com/Dojo-Open-Source-Project/dojo-tools) and are
installed from the npm registry by `npm ci` in `server/`:

| Package | Version | Licence |
| --- | --- | --- |
| `@dojo-tools/auth47` | 2.0.0 | LGPL-3.0 |
| `@dojo-tools/bip47` | 2.0.0 | LGPL-3.0 |

They implement Auth47 challenge verification and BIP47 payment codes, which is
to say the whole of how an operator proves ownership of a listing. Their licence
text ships in each package as `LICENSE.md`, under
`server/node_modules/@dojo-tools/*/`, on any machine that has installed the
dependencies.

**The standing rule: neither is ever bundled, vendored, minified, transpiled or
inlined into anything this repository distributes.** They are named as
dependencies and fetched from the registry by each instance, which is what keeps
them separable and replaceable by an operator, and therefore what keeps an
MIT-licensed repository accurate about itself. Three paths carry code off this
machine and all three exclude `node_modules` today: the deploy workflow's rsync,
`scripts/pack-source.mjs`, and the self-update archive, which is a GitHub
zipball of the source and installs dependencies on the instance afterwards.
Anything new that produces a distributable artefact inherits this rule; a
bundler introduced without reading it would change the licensing position of the
whole tree silently.

## Everything else

The remaining runtime dependencies, including the transitive tree, are permissive:
`@dojo-tools/bitcoinjs-message` (MIT, despite occasional claims otherwise),
`@bitcoinerlab/secp256k1` (MIT), `bip39` (ISC, a development dependency of the
server suite), and the `@noble`, `@scure`, `bs58`, `bip32`, `wif`,
`varuint-bitcoin`, `uint8array-tools`, `base-x` and `valibot` packages beneath
them (MIT). The build-time dependencies at the repository root, TypeScript
(Apache-2.0) and `@types/node` (MIT), produce no distributed artefact, since the
server runs its TypeScript directly under Node's type stripping.

`assets/js/qrcode.js` is vendored rather than installed: QR Code Generator for
JavaScript, copyright (c) 2009 Kazuhiko Arase, MIT, and it carries that notice in
its own header. It is the only vendored third-party file in the tree.

Run `npm ls --all` in `server/` for the tree as installed, which is the
authoritative answer for a given instance.
