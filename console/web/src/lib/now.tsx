import { createContext, use } from "react";

/**
 * The time relative dates are written against. The app reads the wall clock when it renders;
 * stories provide a fixed time so their frames do not change from day to day.
 */
const Now = createContext<number | undefined>(undefined);

export const NowProvider = Now.Provider;

export const useNow = () => use(Now) ?? Date.now();
