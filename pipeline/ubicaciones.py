"""Normalización de provincias y localidades del SEPA.

Los volcados traen la provincia como código ISO (`AR-C`) y las localidades en
mayúsculas, con variantes para el mismo lugar (`CAPITAL FEDERAL`,
`Ciudad Autónoma de Buenos Aires`). Acá se unifican para poder agrupar precios
y armar el buscador por zona.
"""
from __future__ import annotations

import re
import unicodedata

PROVINCIAS = {
    "AR-A": "Salta",
    "AR-B": "Buenos Aires",
    "AR-C": "Ciudad de Buenos Aires",
    "AR-D": "San Luis",
    "AR-E": "Entre Ríos",
    "AR-F": "La Rioja",
    "AR-G": "Santiago del Estero",
    "AR-H": "Chaco",
    "AR-J": "San Juan",
    "AR-K": "Catamarca",
    "AR-L": "La Pampa",
    "AR-M": "Mendoza",
    "AR-N": "Misiones",
    "AR-P": "Formosa",
    "AR-Q": "Neuquén",
    "AR-R": "Río Negro",
    "AR-S": "Santa Fe",
    "AR-T": "Tucumán",
    "AR-U": "Chubut",
    "AR-V": "Tierra del Fuego",
    "AR-W": "Corrientes",
    "AR-X": "Córdoba",
    "AR-Y": "Jujuy",
    "AR-Z": "Santa Cruz",
}

# Variantes que en la práctica designan la ciudad de Buenos Aires como localidad.
ALIAS_LOCALIDAD = {
    "capital federal": "ciudad de buenos aires",
    "caba": "ciudad de buenos aires",
    "ciudad autonoma de buenos aires": "ciudad de buenos aires",
    "ciudad de buenos aires": "ciudad de buenos aires",
    "autonoma de buenos aires": "ciudad de buenos aires",
}

# El SEPA también informa «CIUDAD AUTONOMA BUENOS AIRES» sin «de», «Cdad. de
# Bs.As» y variantes con el número de sucursal entre paréntesis.
VARIANTE_CABA = re.compile(r"^(ciudad|cdad)( autonoma)?( de)? (buenos aires|bs as)$")

# Nombre con el que se muestra una clave normalizada.
NOMBRE_CANONICO = {
    "ciudad de buenos aires": "Ciudad de Buenos Aires",
}

# Partículas que van en minúscula dentro de un nombre propio.
MINUSCULAS = {"de", "del", "la", "las", "los", "y", "e", "en", "al"}

ROMANOS = {"i", "ii", "iii", "iv", "v", "vi"}


def sin_acentos(texto: str) -> str:
    normal = unicodedata.normalize("NFKD", texto)
    return "".join(c for c in normal if not unicodedata.combining(c))


def clave_localidad(texto: str) -> str:
    """Clave de comparación: sin acentos, minúsculas, espacios simples."""
    limpio = re.sub(r"[^a-z0-9 ]+", " ", sin_acentos(texto).lower())
    limpio = re.sub(r"\s+", " ", limpio).strip()
    alias = ALIAS_LOCALIDAD.get(limpio)
    if alias:
        return alias
    # «CIUDAD AUTONOMA DE BUENOS AIRES (901)»: el número es de la sucursal.
    sin_numero = re.sub(r"\s+\d+$", "", limpio)
    alias = ALIAS_LOCALIDAD.get(sin_numero)
    if alias:
        return alias
    if VARIANTE_CABA.match(sin_numero):
        return "ciudad de buenos aires"
    return limpio


def titulo_localidad(texto: str) -> str:
    """Devuelve `CIUDAD DE BUENOS AIRES` como `Ciudad de Buenos Aires`."""
    plano = re.sub(r"\s+", " ", str(texto).strip().lower())
    partes = []
    for i, palabra in enumerate(plano.split(" ")):
        if i and palabra in MINUSCULAS:
            partes.append(palabra)
        elif palabra in ROMANOS:
            partes.append(palabra.upper())
        else:
            partes.append(palabra[:1].upper() + palabra[1:])
    return " ".join(partes)


def nombre_localidad(texto: str) -> str:
    """Nombre visible: unifica las variantes de la ciudad de Buenos Aires."""
    canonico = NOMBRE_CANONICO.get(clave_localidad(texto))
    return canonico or titulo_localidad(texto)


def iso_provincia(valor) -> str | None:
    """Código ISO de provincia a partir del código o del nombre."""
    if valor is None:
        return None
    texto = str(valor).strip()
    if not texto:
        return None
    if texto.upper() in PROVINCIAS:
        return texto.upper()
    plano = sin_acentos(texto).lower()
    if plano in ("buenos aires", "provincia de buenos aires"):
        return "AR-B"
    if plano in ALIAS_LOCALIDAD or plano == "capital federal":
        return "AR-C"
    for iso, nombre in PROVINCIAS.items():
        if sin_acentos(nombre).lower() == plano:
            return iso
    return None


def slug(texto: str) -> str:
    limpio = re.sub(r"[^a-zA-Z0-9]+", "-", sin_acentos(texto).lower())
    return limpio.strip("-")


def slug_provincia(iso: str) -> str:
    return slug(PROVINCIAS[iso])


def zona_localidad(provincia, localidad) -> tuple[str, str] | None:
    """Provincia ISO y clave de localidad, corrigiendo inconsistencias del SEPA.

    Hay sucursales informadas con localidad «Capital Federal» pero provincia
    «Buenos Aires»: la ciudad es su propia jurisdicción, así que se reasigna.
    """
    if localidad is None:
        return None
    iso = iso_provincia(provincia)
    if not iso:
        return None
    clave = clave_localidad(localidad)
    if clave == "ciudad de buenos aires":
        iso = "AR-C"
    return iso, clave
