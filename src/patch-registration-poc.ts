#!/usr/bin/env node
import {
  createRegistrationInsertionFixture,
  createRegistrationInsertionVerificationProfiles,
} from "./patch-phase-c-fixtures.ts";
import { runPhaseCNativeEditsPoc } from "./patch-phase-c-runner.ts";

await runPhaseCNativeEditsPoc({
  scenario: "registration-insertion",
  defaultOutputPrefix: "patch-poc-registration-insertion",
  createFixture: createRegistrationInsertionFixture,
  createProfiles: () => createRegistrationInsertionVerificationProfiles(),
});
