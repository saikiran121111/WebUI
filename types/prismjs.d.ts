// prismjs language component shims
declare module "prismjs/components/prism-*" {
  import Prism from "prismjs";
  const lang: typeof Prism;
  export default lang;
}
