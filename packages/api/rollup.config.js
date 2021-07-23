import { config } from '../../rollup-config';

export default config({
  input: ['./src/index.ts', './src/types.ts', './src/frameworks/react.ts'],
  external: ['typescript'],
});