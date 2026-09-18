// Stays JavaScript: it imports package.json, which TypeScript would need resolveJsonModule for.
import packageJson from '../package.json';

const id = packageJson.name;

export { id };
