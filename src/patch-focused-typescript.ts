import { spawn } from "node:child_process";
import * as ts from "typescript";


const TRUSTED_TYPESCRIPT_CLI = "/opt/pi-rlm/node_modules/typescript/bin/tsc";

type SourceFileWithParseDiagnostics = {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
};

function hasParseDiagnostics(source: ts.SourceFile): boolean {
  const diagnostics = (source as unknown as SourceFileWithParseDiagnostics).parseDiagnostics;
  return Array.isArray(diagnostics) && diagnostics.length > 0;
}

/**
 * Requires one top-level exported featureEnabled declaration whose initializer
 * is the exact executable property access featureConfig.enabled.
 */
export function assertFeatureEnabledReadsFeatureConfig(sourceText: string): void {
  const source = ts.createSourceFile(
    "consumer.ts",
    sourceText,
    ts.ScriptTarget.ES2024,
    true,
    ts.ScriptKind.TS,
  );
  if (hasParseDiagnostics(source)) {
    throw new Error("Focused consumer TypeScript parse failed");
  }
  const declarations = source.statements.flatMap((statement) => {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      return [];
    }
    return statement.declarationList.declarations.filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "featureEnabled",
    );
  });
  const [declaration] = declarations;
  if (
    declarations.length !== 1 ||
    !declaration?.initializer ||
    !ts.isPropertyAccessExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression) ||
    declaration.initializer.expression.text !== "featureConfig" ||
    declaration.initializer.name.text !== "enabled"
  ) {
    throw new Error("Focused consumer must export featureEnabled = featureConfig.enabled");
  }
}

/** Typechecks candidate paths using only the host-mounted TypeScript runtime. */
export async function typecheckCandidate(paths: readonly string[]): Promise<void> {
  const typecheck = spawn(
    process.execPath,
    [
      TRUSTED_TYPESCRIPT_CLI,
      "--allowImportingTsExtensions",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--noEmit",
      "--skipLibCheck",
      "--strict",
      "--target",
      "ES2024",
      ...paths,
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const completion = Promise.withResolvers<void>();
  let complete = false;
  const finish = (passed: boolean): void => {
    if (complete) return;
    complete = true;
    if (passed) completion.resolve();
    else completion.reject(new Error("Focused candidate TypeScript check failed"));
  };
  typecheck.once("error", () => finish(false));
  typecheck.once("exit", (code) => finish(code === 0));
  await completion.promise;
}
