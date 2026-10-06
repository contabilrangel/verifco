import type { FastifyInstance } from 'fastify';
import { parse, requireUser, uuidParam } from '../../lib/http';
import { sendStoredFile } from '../../services/uploads';
import { assertCanDownloadFile } from './access';

/**
 * Download de arquivos do escritório pela rota genérica. Aplica a permissão e o escopo de
 * cliente da tela de origem (documento, DARF, recibo, eCAC, pré-preenchida, pacote de
 * elaboração, anexo de envio, logo). Certificados e backups só saem pelas rotas próprias.
 */
export async function fileRoutes(app: FastifyInstance) {
  app.get('/files/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    await assertCanDownloadFile(app.ctx, user, id);
    const { row, data } = await app.ctx.files.get(user.officeId, id);
    return sendStoredFile(reply, row, data, (req.query as Record<string, string>).inline === '1');
  });
}
