import { Router } from 'express';

export const skillsRouter = Router();

skillsRouter.get('/', (_req, res) => {
  res.json({ skills: [] });
});

skillsRouter.get('/:id/content', (req, res) => {
  res.status(404).json({ error: `Skill '${req.params.id}' is not installed` });
});
