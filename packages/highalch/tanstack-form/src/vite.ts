/**
 * The story kit's Vite plugin: `plugins: [highalch()]` in the Vite (or Vitest) config the stories
 * run with. It lets stories find what the app mounts without the app wiring anything: imports of
 * `@tanstack/react-form` get the kit's wrapper, whose `useForm` registers each form while its
 * component is mounted (everything else is the stock module).
 */
type Resolved = { readonly id: string } | null;

type Context = {
  readonly resolve: (
    source: string,
    importer?: string,
    options?: { readonly skipSelf?: boolean },
  ) => Promise<Resolved>;
};

export const highalch = () => ({
  name: "highalch-story",
  enforce: "pre" as const,
  async resolveId(this: Context, source: string, importer: string | undefined) {
    if (source !== "@tanstack/react-form") return null;

    const wrapper = await this.resolve("@highalch/tanstack-form/react-form", importer, {
      skipSelf: true,
    });

    // The wrapper itself imports the stock module.
    if (!wrapper || importer === wrapper.id) return null;

    return wrapper.id;
  },
});
