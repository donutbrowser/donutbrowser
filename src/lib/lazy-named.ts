import { type ComponentType, lazy } from "react";

const loaders: (() => Promise<unknown>)[] = [];

/**
 * React.lazy for a named export: the module becomes its own chunk, kept out of
 * the code the app parses at startup. Render it inside a Suspense boundary.
 */
export function lazyNamed<
  K extends string,
  M extends Record<K, ComponentType<any>>,
>(load: () => Promise<M>, name: K) {
  loaders.push(load);
  return lazy(() => load().then((module) => ({ default: module[name] })));
}

/** Loads every lazy chunk ahead, so opening one later does not wait. */
export function preloadLazyChunks() {
  for (const load of loaders.splice(0)) void load().catch(() => {});
}
