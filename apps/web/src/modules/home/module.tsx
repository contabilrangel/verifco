import type { VerifcoModule } from '../../app/modules';
import { HomePage } from './HomePage';

export const module: VerifcoModule = {
  routes: [{ index: true, element: <HomePage /> }],
};
