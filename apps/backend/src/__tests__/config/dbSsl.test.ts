jest.mock('fs', () => ({ readFileSync: jest.fn() }));

import * as fs from 'fs';
import { buildSslOptions } from '../../config/dbSsl';

const readFileSync = fs.readFileSync as unknown as jest.Mock;

describe('buildSslOptions', () => {
  const original = { ...process.env };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.DB_SSL_CA;
    delete process.env.DB_SSL_REJECT_UNAUTHORIZED;
    process.env.NODE_ENV = 'test';
    readFileSync.mockReset();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...original };
  });

  it('verifies the server certificate by default', () => {
    expect(buildSslOptions()).toEqual({ rejectUnauthorized: true });
  });

  it('uses a CA bundle when one is configured', () => {
    readFileSync.mockReturnValue('---CA---');
    process.env.DB_SSL_CA = '/etc/ssl/ionos.pem';
    expect(buildSslOptions()).toEqual({ ca: '---CA---', rejectUnauthorized: true });
  });

  it('throws rather than silently downgrading when the CA path is wrong', () => {
    readFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    process.env.DB_SSL_CA = '/typo/ionos.pem';
    // A typo must cost a boot failure, not the encryption guarantee.
    expect(() => buildSslOptions()).toThrow(/could not be read/);
  });

  it('allows disabling verification outside production, loudly', () => {
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    expect(buildSslOptions()).toEqual({ rejectUnauthorized: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DISABLED'));
  });

  it('refuses to disable verification in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    expect(() => buildSslOptions()).toThrow(/not permitted in production/);
  });

  it('still verifies in production when nothing is set', () => {
    process.env.NODE_ENV = 'production';
    expect(buildSslOptions()).toEqual({ rejectUnauthorized: true });
  });

  it('prefers an explicit CA over the escape hatch', () => {
    readFileSync.mockReturnValue('---CA---');
    process.env.DB_SSL_CA = '/etc/ssl/ionos.pem';
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    expect(buildSslOptions()).toEqual({ ca: '---CA---', rejectUnauthorized: true });
  });

  it('treats any value other than the literal "false" as verify', () => {
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'no';
    expect(buildSslOptions()).toEqual({ rejectUnauthorized: true });
  });
});
