/** validate(zodSchema, 'body' | 'query') -> replaces req[where] with the parsed (typed, trimmed) value. */
const validate = (schema, where = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[where]);
  if (!result.success) return next(result.error);
  req[where] = result.data;
  return next();
};

module.exports = { validate };
