/** Ambient shims for bundler-style imports inside the DSH client bundle. */
declare module '*?dsh-raw' {
  const content: string
  export default content
}
