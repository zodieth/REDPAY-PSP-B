-- Importes siempre en centavos (bigint). Fechas en timestamptz.

CREATE TABLE comercios (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre                    text NOT NULL,
  cuit                      text,
  -- Comisión en puntos básicos sobre el bruto: 600 = 6 %.
  comision_pb               integer NOT NULL DEFAULT 600 CHECK (comision_pb BETWEEN 0 AND 10000),
  -- Cuánto queda bloqueado un CVU esperando el pago, y la cuarentena antes de reusarlo.
  bloqueo_horas             integer NOT NULL DEFAULT 120,
  cuarentena_pagado_horas   integer NOT NULL DEFAULT 48,
  cuarentena_vencido_horas  integer NOT NULL DEFAULT 168,
  activo                    boolean NOT NULL DEFAULT true,
  creado_at                 timestamptz NOT NULL DEFAULT now()
);

-- Se guarda sólo el sha256 de la clave; el prefijo sirve para reconocerla en el panel.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comercio_id  uuid NOT NULL REFERENCES comercios(id),
  prefijo      text NOT NULL,
  hash         text NOT NULL UNIQUE,
  creada_at    timestamptz NOT NULL DEFAULT now(),
  revocada_at  timestamptz
);

-- Pool de cuentas recaudadoras de cargavirtual. Cada una tiene un CVU/alias propio
-- y se presta a un cobro por vez.
--   libre -> asignado -> cuarentena -> libre
--   deshabilitado: no se asigna (login roto, dada de baja, etc.)
CREATE TABLE cvus (
  id                serial PRIMARY KEY,
  usuario           text NOT NULL,
  clave_cifrada     text NOT NULL,
  pv                text NOT NULL,
  cvu               text NOT NULL UNIQUE,
  alias             text,
  titular           text,
  estado            text NOT NULL DEFAULT 'libre'
                    CHECK (estado IN ('libre', 'asignado', 'cuarentena', 'deshabilitado')),
  -- Asignado: el cobro actual. Cuarentena: el último cobro (para imputar pagos tardíos).
  cobro_id          uuid,
  libre_desde       timestamptz NOT NULL DEFAULT now(),
  cuarentena_hasta  timestamptz,
  -- Poller
  inicializado      boolean NOT NULL DEFAULT false,
  ultima_sync       timestamptz,
  proxima_sync      timestamptz NOT NULL DEFAULT now(),
  ultimo_error      text,
  creado_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (usuario, pv)
);
CREATE INDEX cvus_libres ON cvus (libre_desde) WHERE estado = 'libre';
CREATE INDEX cvus_proxima_sync ON cvus (proxima_sync) WHERE estado <> 'deshabilitado';

--   borrador -> pendiente -> (parcial) -> pagado
--                         \-> vencido | cancelado
-- borrador: creado sin CVU (Medusa crea la sesión antes de confirmar la orden).
CREATE TABLE cobros (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comercio_id      uuid NOT NULL REFERENCES comercios(id),
  referencia       text,
  importe          bigint NOT NULL CHECK (importe > 0),
  moneda           text NOT NULL DEFAULT 'ARS',
  estado           text NOT NULL DEFAULT 'borrador'
                   CHECK (estado IN ('borrador', 'pendiente', 'parcial', 'pagado', 'vencido', 'cancelado')),
  recibido         bigint NOT NULL DEFAULT 0,
  cvu_id           integer REFERENCES cvus(id),
  asignado_at      timestamptz,
  vence_at         timestamptz,
  pagado_at        timestamptz,
  cerrado_at       timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}',
  idempotency_key  text,
  creado_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comercio_id, idempotency_key)
);
CREATE INDEX cobros_comercio ON cobros (comercio_id, creado_at DESC);
CREATE INDEX cobros_abiertos ON cobros (vence_at) WHERE estado IN ('pendiente', 'parcial');

ALTER TABLE cvus ADD FOREIGN KEY (cobro_id) REFERENCES cobros(id);

-- Depósitos leídos de cargavirtual. El id es el de cargavirtual (global).
--   cobro:     imputado al cobro que tenía el CVU asignado
--   tardio:    llegó con el CVU en cuarentena (cobro ya pagado/vencido/cancelado)
--   huerfano:  CVU libre o fecha anterior a la asignación; se imputa a mano
--   manual:    huérfano que alguien imputó desde el backoffice
--   historico: importado en la primera lectura de la cuenta, no se procesa
CREATE TABLE depositos (
  id               text PRIMARY KEY,
  cvu_id           integer NOT NULL REFERENCES cvus(id),
  cobro_id         uuid REFERENCES cobros(id),
  imputacion       text NOT NULL CHECK (imputacion IN ('cobro', 'tardio', 'huerfano', 'manual', 'historico')),
  importe          bigint NOT NULL,
  fecha_deposito   timestamptz,
  fecha_carga      timestamptz,
  banco            text,
  cuenta           text,
  nro_transaccion  text,
  observaciones    text,
  detectado_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX depositos_cobro ON depositos (cobro_id);
CREATE INDEX depositos_huerfanos ON depositos (detectado_at) WHERE imputacion = 'huerfano';

CREATE TABLE retiros (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comercio_id   uuid NOT NULL REFERENCES comercios(id),
  importe       bigint NOT NULL CHECK (importe > 0),
  entregado_por text NOT NULL,
  recibido_por  text NOT NULL,
  comprobante   text,
  notas         text,
  creado_at     timestamptz NOT NULL DEFAULT now()
);

-- Libro del comercio. Inmutable: el saldo es la suma de importe.
CREATE TABLE movimientos (
  id           bigserial PRIMARY KEY,
  comercio_id  uuid NOT NULL REFERENCES comercios(id),
  tipo         text NOT NULL CHECK (tipo IN ('cobro', 'comision', 'retiro', 'ajuste')),
  importe      bigint NOT NULL,
  cobro_id     uuid REFERENCES cobros(id),
  deposito_id  text REFERENCES depositos(id),
  retiro_id    uuid REFERENCES retiros(id),
  descripcion  text,
  creado_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deposito_id, tipo)
);
CREATE INDEX movimientos_comercio ON movimientos (comercio_id, id DESC);

CREATE TABLE webhooks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comercio_id  uuid NOT NULL REFERENCES comercios(id),
  url          text NOT NULL,
  secreto      text NOT NULL,
  activo       boolean NOT NULL DEFAULT true,
  creado_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entregas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id       uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  evento           text NOT NULL,
  payload          text NOT NULL,
  estado           text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'entregada', 'fallida')),
  intentos         integer NOT NULL DEFAULT 0,
  proximo_intento  timestamptz NOT NULL DEFAULT now(),
  ultimo_status    integer,
  ultimo_error     text,
  creado_at        timestamptz NOT NULL DEFAULT now(),
  entregado_at     timestamptz
);
CREATE INDEX entregas_cola ON entregas (proximo_intento) WHERE estado = 'pendiente';
