-- Usuarios del panel. admin: backoffice de redpagos. comercio: ve sólo su comercio.
CREATE TABLE usuarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  nombre        text,
  clave_hash    text NOT NULL,                -- scrypt: sal.hash en hex
  rol           text NOT NULL CHECK (rol IN ('admin', 'comercio')),
  comercio_id   uuid REFERENCES comercios(id),
  activo        boolean NOT NULL DEFAULT true,
  ultimo_login  timestamptz,
  creado_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((rol = 'comercio') = (comercio_id IS NOT NULL))
);

-- Quién cambió qué: configuración de comercios (comisión incluida) y ajustes de saldo.
CREATE TABLE auditoria (
  id           bigserial PRIMARY KEY,
  actor        text NOT NULL,                 -- email del usuario o "api-admin"
  comercio_id  uuid REFERENCES comercios(id),
  accion       text NOT NULL,
  antes        jsonb,
  despues      jsonb,
  creado_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_comercio ON auditoria (comercio_id, id DESC);
