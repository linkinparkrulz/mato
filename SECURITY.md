# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

The preferred route is GitHub's **[private vulnerability
reporting](https://github.com/Dojobay/dojobay/security/advisories/new)**. It is
private between you and the maintainer, needs no email address from either side,
and keeps the report attached to the repository.

If you would rather not use GitHub, or want to encrypt the report, the
maintainer's OpenPGP key is:

```
602234D3F520354C6AF511987610EEEFFD25FEC5
```

[Fetch it from keys.openpgp.org](https://keys.openpgp.org/vks/v1/by-fingerprint/602234D3F520354C6AF511987610EEEFFD25FEC5),
or with `gpg --locate-keys` if you already know the address. Encrypted mail is
welcome; unencrypted mail about a vulnerability is not, which is why no address
is published here in the clear.

Please include what you would want to receive yourself: what the problem is, how
to reproduce it, what an attacker gains, and the version or commit you looked at
(the footer of any instance shows its build hash).

## What is in scope

This project is a directory. The most valuable things to attack are the claims
it makes, so those are the most valuable things to report:

- **Signature verification.** Anything that makes the directory accept a pairing
  payload, an operator binding or a domain claim that was not signed by the
  payment code it claims, or reject one that was.
- **Ownership and sign-in.** Anything that lets one payment code edit, remove or
  impersonate another operator's listing, or that lets a session be taken over.
- **The verified-domain proof.** Anything that produces a badge without control
  of both the domain and the payment code, including through a bootstrap import
  from another instance.
- **The self-update and bootstrap paths.** Anything that gets code or data onto
  an instance without the operator-binding trust gate, including archive
  traversal and unverified peers.
- **Anything that unmasks an operator or a visitor**, particularly a path that
  leaks a request outside Tor.

## What is not

- **A node behaving badly is not a vulnerability in this software.** The
  directory lists Dojos run by other people; it does not vouch for them, and
  says so throughout. Report an abusive listing as an ordinary issue, or to the
  maintainer, and it can be delisted.
- **A node being down**, or a status being stale, is an operational matter.
- **Missing hardening that costs nothing to attack**, such as headers on a
  static onion site, is welcome as an ordinary issue rather than an advisory.

## What to expect

A single maintainer works on this, so the honest commitment is a first reply
within a week rather than a same-day acknowledgement. If a report is valid,
you should expect: agreement on what the problem is, a fix, and credit in the
release notes unless you would rather not be named. Where a fix affects other
instances, they are told through the release notes and the in-app update check
before details are published.

## Supported versions

The latest release is the supported one. Instances update from GitHub or from a
peer, and the admin console reports how far behind an instance is, so there is
no long-term support branch to maintain.
