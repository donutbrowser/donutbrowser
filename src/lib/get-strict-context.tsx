import * as React from "react";

function getStrictContext<T>(
  name?: string,
): readonly [
  ({
    value,
    children,
  }: {
    value: T;
    children?: React.ReactNode;
  }) => React.JSX.Element,
  () => T,
] {
  const Context = React.createContext<T | undefined>(undefined);

  // biome-ignore lint/correctness/noComponentHookFactories: called once per context at module scope, so each context has one stable Provider.
  const Provider = ({
    value,
    children,
  }: {
    value: T;
    children?: React.ReactNode;
  }) => <Context.Provider value={value}>{children}</Context.Provider>;

  // biome-ignore lint/correctness/noComponentHookFactories: made once with its Provider, at module scope.
  const useSafeContext = () => {
    const ctx = React.useContext(Context);
    if (ctx === undefined) {
      throw new Error(`useContext must be used within ${name ?? "a Provider"}`);
    }
    return ctx;
  };

  return [Provider, useSafeContext] as const;
}

export { getStrictContext };
