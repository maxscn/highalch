import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "../../../components/page.tsx";
import { Empty, Panel } from "../../../components/ui/panel.tsx";

/** Fuzzing (deferred by the owner): the run overview shows a fuzz run's counts meanwhile. */
export const Route = createFileRoute("/$org/$project/fuzzing")({
  component: () => (
    <>
      <PageHeader id="fuzzing-title" title="Fuzzing" />
      <Panel>
        <Empty>
          The fuzzing screens come in a later round. Fuzz runs show their counts on the run page.
        </Empty>
      </Panel>
    </>
  ),
});
