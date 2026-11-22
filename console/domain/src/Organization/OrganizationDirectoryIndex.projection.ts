import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { OrganizationCreated } from "./CreateOrganization.command.ts";
import { Organization } from "./Organization.aggregate.ts";
import {
  Directory,
  OrganizationDirectory,
  OrganizationListed,
} from "./OrganizationDirectory.stream.ts";

export class OrganizationDirectoryIndex extends Domain.Projection("OrganizationDirectoryIndex", {
  from: [Organization],
  key: Directory,
  keyOf: { OrganizationCreated: () => "all" as const },
  on: [OrganizationCreated],
  writes: [OrganizationDirectory],
}) {}

export const OrganizationDirectoryIndexLive = OrganizationDirectoryIndex.toLayer(
  Effect.gen(function* () {
    const directory = yield* OrganizationDirectory;
    return Effect.fn(function* (batch) {
      for (const input of batch)
        yield* directory.append(input, new OrganizationListed({ org: input.source.id }));
    });
  }),
);
