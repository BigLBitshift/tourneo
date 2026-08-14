/**
 * The payments switch decides whether version 1 can ship as a free app.
 * These pin the two things that would break that: Stripe becoming
 * mandatory again, and the switch defaulting to on.
 */
describe('payments feature switch', () => {
  const original = { ...process.env };

  const loadEnv = () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../config/environment');
  };

  const productionBase = () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(40);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(40);
    process.env.APP_URL = 'https://tourneo.de';
    process.env.ADMIN_URL = 'https://admin.tourneo.de';
    process.env.DB_PASSWORD = 'secret';
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  };

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
  });

  it('is off unless explicitly enabled', () => {
    delete process.env.PAYMENTS_ENABLED;
    expect(loadEnv().env.features.payments).toBe(false);
  });

  it('treats any value other than the literal "true" as off', () => {
    process.env.PAYMENTS_ENABLED = '1';
    expect(loadEnv().env.features.payments).toBe(false);
    process.env.PAYMENTS_ENABLED = 'yes';
    expect(loadEnv().env.features.payments).toBe(false);
  });

  it('turns on with the literal "true"', () => {
    process.env.PAYMENTS_ENABLED = 'true';
    expect(loadEnv().env.features.payments).toBe(true);
  });

  it('does not require Stripe credentials in a free production build', () => {
    productionBase();
    process.env.PAYMENTS_ENABLED = 'false';
    expect(() => loadEnv().validateEnv()).not.toThrow();
  });

  it('requires Stripe credentials as soon as payments are on', () => {
    productionBase();
    process.env.PAYMENTS_ENABLED = 'true';
    expect(() => loadEnv().validateEnv()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('still enforces every non-payment production requirement', () => {
    productionBase();
    process.env.PAYMENTS_ENABLED = 'false';
    delete process.env.APP_URL;
    expect(() => loadEnv().validateEnv()).toThrow(/APP_URL/);
  });
});
