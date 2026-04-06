/// <reference types="bun-types" />

declare module "*.md?raw" {
  const content: string;
  export default content;
}
