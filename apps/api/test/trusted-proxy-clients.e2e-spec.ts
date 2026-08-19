import { TrustedProxyClients } from './support/trusted-proxy';

describe('TrustedProxyClients', () => {
  const originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;

  afterEach(() => {
    if (originalTrustedProxyIps === undefined) {
      delete process.env.TRUSTED_PROXY_IPS;
    } else {
      process.env.TRUSTED_PROXY_IPS = originalTrustedProxyIps;
    }
  });

  it('restores the value the process started with', () => {
    process.env.TRUSTED_PROXY_IPS = '203.0.113.7';
    const clients = new TrustedProxyClients();

    clients.enable();
    expect(process.env.TRUSTED_PROXY_IPS).toBe('loopback');

    clients.restore();
    expect(process.env.TRUSTED_PROXY_IPS).toBe('203.0.113.7');
  });

  it('removes a variable the process did not set', () => {
    delete process.env.TRUSTED_PROXY_IPS;
    const clients = new TrustedProxyClients();

    clients.enable();
    clients.restore();

    expect(process.env.TRUSTED_PROXY_IPS).toBeUndefined();
  });

  // A caller that closes its application before restoring loses the restore
  // when the close rejects. The next test's `enable()` must still set up a
  // usable environment instead of turning one broken shutdown into a failure
  // for every remaining test in the suite.
  it('tolerates a re-enable after a restore was skipped', () => {
    process.env.TRUSTED_PROXY_IPS = '203.0.113.7';
    const clients = new TrustedProxyClients();

    clients.enable();
    expect(() => clients.enable()).not.toThrow();
    expect(process.env.TRUSTED_PROXY_IPS).toBe('loopback');

    // The skipped restore must not have overwritten the original value with
    // the harness's own `loopback`.
    clients.restore();
    expect(process.env.TRUSTED_PROXY_IPS).toBe('203.0.113.7');
  });

  it('issues a distinct address per call within one enabled application', () => {
    const clients = new TrustedProxyClients();
    clients.enable();

    const issued = [clients.nextAddress(), clients.nextAddress(), clients.nextAddress()];

    expect(issued).toEqual(['198.51.100.1', '198.51.100.2', '198.51.100.3']);
    clients.restore();
  });

  // Rate-limit buckets live in the application, so a new one starts with empty
  // buckets and the block may be drawn from the start again. Keeping the count
  // across applications would exhaust it for a limit that never applied.
  it('restarts the address block for the next application', () => {
    const clients = new TrustedProxyClients();

    clients.enable();
    expect(clients.nextAddress()).toBe('198.51.100.1');
    clients.restore();

    clients.enable();
    expect(clients.nextAddress()).toBe('198.51.100.1');
    clients.restore();
  });

  it('refuses to issue an address outside the block', () => {
    const clients = new TrustedProxyClients();
    clients.enable();

    for (let issued = 0; issued < 254; issued += 1) {
      clients.nextAddress();
    }

    expect(() => clients.nextAddress()).toThrow(/more than 254 client addresses/);
    clients.restore();
  });
});
