#!/usr/bin/env node
import {
  createTwoFileWiringFixture,
  createTwoFileWiringVerificationProfiles,
} from "./patch-phase-c-fixtures.ts";
import { runPhaseCNativeEditsPoc } from "./patch-phase-c-runner.ts";

await runPhaseCNativeEditsPoc({
  scenario: "two-file-wiring",
  defaultOutputPrefix: "patch-poc-two-file-wiring",
  createFixture: createTwoFileWiringFixture,
  createProfiles: () => createTwoFileWiringVerificationProfiles(),
});
