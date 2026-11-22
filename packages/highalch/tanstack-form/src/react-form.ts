/**
 * `@tanstack/react-form` as stories see it: everything as is, with `useForm` registering the
 * form it makes while its component is mounted. The story kit's Vite resolve hook swaps this
 * module in for the app's imports; the app's code is unchanged.
 */
import { useForm as stock } from "@tanstack/react-form";
import { useSyncExternalStore } from "react";
import { subscriptionOf } from "./registry";

export * from "@tanstack/react-form";

const snapshot = () => true;

export const useForm: typeof stock = (options) => {
  const form = stock(options);

  useSyncExternalStore(subscriptionOf(form), snapshot, snapshot);

  return form;
};
