# E2E-Tests (Maestro)

Installation: `curl -Ls https://get.maestro.mobile.dev | bash`

```bash
export TEST_EMAIL=...   # Seed-Admin oder Test-Account
export TEST_PASSWORD=...
maestro test .maestro/booking-flow.yaml
maestro test .maestro/registration-flow.yaml
```

Beide Flows decken die zwei Money-Paths ab: Platzbuchung und
Turnier-Anmeldung. Vor dem Lauf Backend mit Seeds starten
(`npm run backend:migrate && npm run --workspace=apps/backend seed`).
