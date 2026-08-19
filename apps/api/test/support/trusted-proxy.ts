/**
 * Shared setup for E2E suites that must present a distinct client address per
 * request. Rate limits are keyed by client address, and a suite that creates
 * more accounts per minute than one client may would otherwise fail on the
 * authentication limit instead of on the behaviour under test.
 *
 * The three pieces belong together: the addresses are only believed while
 * `TRUSTED_PROXY_IPS` names the loopback address the supertest client comes
 * from, and the environment variable must be restored so a later suite in the
 * same worker sees the value it started with. Keeping them in one place also
 * keeps the address block's size in one place — every caller drew from
 * `198.51.100.0/24` and each carried its own unwritten assumption that the
 * counter stays below 256.
 *
 * This file is not collected as a suite: `test/jest-e2e.json` matches
 * `.e2e-spec.ts$`.
 */

/** RFC 5737 TEST-NET-2, reserved for documentation and never routed. */
const clientAddressPrefix = '198.51.100';
const lastClientAddressHost = 254;

export class TrustedProxyClients {
  private originalTrustedProxyIps: string | undefined;
  private enabled = false;
  private issuedAddressCount = 0;

  /**
   * Must run before the testing module is compiled: the proxy setting is read
   * while the application is configured, not per request.
   */
  enable(): void {
    if (this.enabled) {
      throw new Error('The trusted-proxy environment is already enabled');
    }

    this.originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;
    this.enabled = true;
    process.env.TRUSTED_PROXY_IPS = 'loopback';
  }

  restore(): void {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;

    if (this.originalTrustedProxyIps === undefined) {
      delete process.env.TRUSTED_PROXY_IPS;
    } else {
      process.env.TRUSTED_PROXY_IPS = this.originalTrustedProxyIps;
    }
  }

  /**
   * Returns an address no earlier call returned. Exhaustion throws rather than
   * wrapping around or emitting an octet above 255: a repeated address would
   * resurface as an unexplained `429` far from its cause.
   */
  nextAddress(): string {
    this.issuedAddressCount += 1;

    if (this.issuedAddressCount > lastClientAddressHost) {
      throw new Error(
        `The suite requested more than ${lastClientAddressHost} client addresses from ` +
          `${clientAddressPrefix}.0/24; split it or reuse sessions instead.`,
      );
    }

    return `${clientAddressPrefix}.${this.issuedAddressCount}`;
  }
}
