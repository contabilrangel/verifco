import type { FastifyInstance } from 'fastify';
import { parse, requireUser, uuidParam } from '../../lib/http';

/** Download de arquivos do escritório (respeita o isolamento por escritório). */
export async function fileRoutes(app: FastifyInstance) {
  app.get('/files/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const { row, data } = await app.ctx.files.get(user.officeId, id);
    const inline = (req.query as Record<string, string>).inline === '1';
    reply
      .header('Content-Type', row.mimeType)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    return reply.send(data);
  });
}
