import type { AnyFormApi } from "@tanstack/react-form";

/** The forms mounted now, in mount order (a form that remounts is a new entry). */
const mounted: Array<AnyFormApi> = [];

/** Every mounted form now, in mount order. */
export const forms = (): ReadonlyArray<AnyFormApi> => [...mounted];

const subscriptions = new WeakMap<AnyFormApi, () => () => void>();

/**
 * The external-store subscription that keeps a form registered while a component that made it is
 * mounted: React subscribes on mount and unsubscribes on unmount (twice in StrictMode).
 */
export const subscriptionOf = (form: AnyFormApi) => {
  const known = subscriptions.get(form);

  if (known) return known;

  const subscribe = () => {
    if (!mounted.includes(form)) mounted.push(form);

    return () => {
      const at = mounted.indexOf(form);

      if (at >= 0) mounted.splice(at, 1);
    };
  };

  subscriptions.set(form, subscribe);

  return subscribe;
};
