import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "vite-plus/test";
import { ConsoleApi } from "../src/Console.api.ts";
import { Console } from "../src/Console.model.ts";

describe("Console model", () => {
  it("is well defined", () => {
    expect(Domain.verify(Console)).toEqual([]);
  });

  it("serves clients only commands that authenticate their caller", () => {
    const commands: ReadonlyArray<{
      readonly tag: string;
      readonly middleware: ReadonlyArray<unknown>;
    }> = ConsoleApi.commands;
    const unguarded = commands.filter((c) => c.middleware.length === 0).map((c) => c.tag);
    expect(unguarded).toEqual([]);
    const served = commands.map((command) => command.tag);
    for (const serverOnly of ["ActivatePlan", "CreditTopUp", "SuspendBilling", "ReferenceBlob"])
      expect(served).not.toContain(serverOnly);
  });
});
