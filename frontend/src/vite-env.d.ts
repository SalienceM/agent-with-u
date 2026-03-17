/// <reference types="vite/client" />

// CSS ?inline import support
declare module '*.css?inline' {
  const css: string;
  export default css;
}
