"""Construye el maestro de productos y asigna categorías.

El volcado del SEPA no trae rubro ni subcategoría: se clasifica por palabras
clave sobre nombre y marca. Las reglas son explícitas y ordenadas.
"""
from __future__ import annotations

import duckdb

from config import DATA, PRECIOS_PARQUET, PRODUCTOS_PARQUET

# (slug, nombre visible, patrón) — el primero que coincide gana.
#
# Dos reglas al tocar esto:
#  1. Orden por especificidad: mascotas y bebés antes de carnes/almacén, porque
#     "ALIM. P/GATOS ... PESCADO" o "LECHE INFANTIL" mencionan palabras de otras
#     categorías.
#  2. Anclar con \b los tokens cortos. Sin ancla, "CRIOLLA" cae en bazar (OLLA),
#     "TIRABUZÓN" en textil (BUZO), "DIAMANTADO" en textil (MANTA) y
#     "SENSODYNE" en textil (BODY).
CATEGORIAS: list[tuple[str, str, str]] = [
    ("mascotas", "Mascotas", r"\bPERROS?\b|\bGATOS?\b|MASCOTA|BALANCEADO|WHISKAS|PEDIGREE|DOG CHOW|CAT CHOW|NUTRECAT|PRO PLAN|EUKANUBA|MISTER DOG|ALIM\.? ?P/GATOS|ALIM\.? ?P/PERROS|ARENA SANITARIA|ARENA MINERAL|ARENA AGLUTINANTE|ARENA PARA GATO|PIEDRAS SANITARIAS|\bPRETAL\b|\bCORREA\b"),
    ("limpieza", "Limpieza", r"LAVANDINA|DETERGENTE|JABON EN POLVO|JABON LIQUIDO PARA ROPA|SUAVIZANTE|LIMPIADOR|\bLIMPIA|LIMP\. ?(CREMOSO|VIDRIO|PISO|BANO|BAÑO|MUEBLE|MULTIUSO|INODORO)|DESINFECT|CLORO|TRAPO|ESCOBA|ESCOBILLON|LAVAVAJILLA|BOLSA DE RESIDUO|RESIDUOS?|ROLLO DE COCINA|PAPEL DE ALUMINIO|FOSFORO|\bVELA|INSECTICIDA|AROMATIZANTE|DESODORANTE DE AMBIENTE|DESOD\.? AMBIENTE|\bCIF\b|HARPIC|AYUDIN|VANISH|MAGISTRAL|\bPATO\b|MR MUSCULO|QUITAMANCHAS|LUSTRAMUEBLE|\bGUANTES?\b|LAVAVAJILLAS|\bRAID\b|\bPOMADA\b|\bCALZADO\b|\bINODORO\b|\bCANASTA\b|ESPONJA|SCOTCH BRITE|DESTAPA|DESTAPADOR|PLOMERO"),
    ("higiene", "Higiene y perfumería", r"SHAMP|ACONDICION|\bACOND\b|JABON DE TOCADOR|\bJABON|DESOD|ANTITRANSP|ANTIRANSP|\bANTITR|PASTA DENTAL|\bDENTAL\b|\bCEPILLO|ENJUAGUE|BUCAL|PAPEL HIGIENICO|TOALLA HIG|TOALLITAS|TOALLAS HUMEDAS|\bPANAL|\bPAÑAL|\bTAMPON|PROTECTOR|PROT\.|\bPROT |PERFUME|AFEIT|MAQUILLAJE|CREMA CORP|CREMA FACIAL|ALGODON|HISOPO|QUITAESMALTE|TINTURA|COLORACION|PEDICO|\bAPOSITO|CURITA|HIGIENIC|AGUA OXIGENADA|\bALCOHOL\b|\bGEL\b|DESMAQUILL|\bSH\.|\bDEO\b|\bDES AER\b|\bTALCO\b|\bCERA\b|DEPILATORIA|\bPAÑUELO|\bPANUELO|ESCARBADIENTE|\bBIC\b|FRIZANTE|FRIZZE|MAQUINA DESECHABLE|MAQUINA DE AFEITAR"),
    ("bebes", "Bebés", r"\bBEBES?\b|INFANTIL|MAMADERA|CHUPETE|LECHE INFANTIL|\bNIDO\b|FORMULA LACTEA|ETAPA [0-9]"),
    ("lacteos", "Lácteos", r"LECHE|YOGUR|YOGHURT|\bYOG\.|QUESO|MANTECA|\bMANT\.|MARGARINA|CREMA DE LECHE|RICOTA|RICOTTA|Q\.? ?PROCESADO|QSO|SERENISIMA|MILKOUT|DULCE DE LECHE"),
    ("bebidas", "Bebidas", r"\bAGUA\b|GASEOSA|JUGOS?|\bJUGO\b|\bFIZZ\b|GIN ?TONIC|CERVEZA|VINO|FERNET|COCA|PEPSI|\bSODA\b|ISOTONIC|ENERGIZ|AMARGO|CHAMPAGNE|ESPUMANTE|SIDRA|WHISKY|VODKA|\bGIN\b|LICOR|APERITIVO|SABORIZADA|\bBEBIDA|\bBEB\.|NECTAR|\bMALTA\b|VERMOUTH"),
    ("almacen", "Almacén", r"ARROZ|FIDEOS?|FID\.|RAVIOL|CAPELETTINI|SORRENTINO|HARINA|ACEITE|AZUCAR|YERBA|\bHRB\b|\bMATE\b|MATECOCIDO|CAFE|\bTE\b|\bSAL\b|LENTEJA|GARBANZO|\bPURE\b|SALSA|MAYONESA|MOSTAZA|KETCHUP|ATUN|SARDINA|GALLETITA|GALL\.|GALLET|\bGALLE|ALMOHADITA|BIZCOCHO|CHOCLO|ARVEJA|POLENTA|REBOZADOR|CALDO|SOPA|MERMELADA|\bMIEL\b|CACAO|CHOCOLATE|ALFAJOR|GOLOSINA|CARAMELO|\bCARAM|\bCHICLE|\bPASTILLA|GELATINA|\bGOMAS FRUTALES|GOMITAS|\bDULCE DE|SNACK|PAPAS FRITAS|\bMANI\b|POSTRE|ALMIDON|SEMOLA|CONDIMENTO|OREGANO|PIMENTON|PIMIENTA|COMINO|COCO RALLADO|PRE MEZCLA|\bCHIPA\b|TOMATE PELADO|TOMATE TRITURADO|TOMATE PERITA|TOMATE CUBETEADO|TOMATE EN LATA|EXTRACTO (SIMPLE )?DE TOMATE|VEGETAL(ES)? DESHIDRATA|CEBOLLA DESHIDRATADA|CEBOLLA EN POLVO|AJO TRITURADO|AJO DESHIDRATADO|AJO EN POLVO|VINAGRE|TUBO DE MAIZ|PALITOS|KRACH|CHUPETIN|BOCADITO|BANANITA|BOMBON|EDULCORANTE|ENDULZANTE|\bFLAN\b|POLVO PARA HORNEAR|\bOBLEA|SERENITO|AVENA|CEREAL|\bBARRA\b|RISOTTO|GUISO|LOCRO|NOQUIS|TORTILLA|SEMILLAS|FRUTOS SECOS|ESENCIA|ACEITUNA|CAPPELLETTI|NACHO|TOSTITOS|\bMERM\.|\bCER\.|NESTUM|COCTEL"),
    ("congelados", "Congelados", r"CONGELAD|HELADO|PIZZA|EMPANADA|HAMBURGUESA|NUGGET|PATITAS|PAPAS PRE ?FRITAS|MC CAIN|\bHIELO\b|VEGGIE|VEGETALEX|MEDALLON VEG"),
    ("panificados", "Panificados", r"\bPAN\b|PAN RALLADO|FACTURA|MEDIALUNA|BUDIN|BIZCOCHUELO|TOSTADA|\bTARTA|PASCUALINA|HOJALDR|RAPIDITA|\bWRAPS?\b|PIONONO|MASAS|TAPAS? EMPANAD|TAPA P/EMPANAD|LEVADURA"),
    ("carnes", "Carnes y pescados", r"CARNE|POLLO|CERDO|PESCADO|MILANESA|CHORIZO|JAMON|SALCHICH|MORCILLA|ASADO|BIFE|PECHUGA|\bPECHO\b|COSTILLA|PANCETA|BONDIOLA|MATAMBRE|POLLERIA|CARNICERIA|\bLOMO\b|CHURRASCO|OSOBUCO|LEBERWURST|SALAME|\bFUET\b|MORTADELA|SALAMIN"),
    ("frutas_verduras", "Frutas y verduras", r"MANZANA|BANANA|\bPAPAS?\b|TOMATE|CEBOLLA|ZANAHORIA|LECHUGA|LIMON|NARANJA|\bPERA\b|FRUTILLA|ZAPALLO|ZAPALLITO|VERDURA|FRUTA|PALTA|BROCOLI|COLIFLOR|\bAPIO\b|\bACELGA\b|ESPINACA|REPOLLO|REMOLACHA|BATATA|ARANDANO|FRAMBUESA|CEREZA|DURAZNO|\bUVA\b|MANDARINA|POMELO|\bKIWI\b|ANANA|SANDIA|MELON|\bAJO EN MALLA\b|CHOCLO FRESCO"),
    ("electro", "Electrodomésticos", r"HELADERA|LAVARROPA|LAVASECARROPA|SECARROPA|TELEVISOR|\bTV\b|MICROONDAS|AIRE ACONDICIONADO|CELULAR|NOTEBOOK|COMPUTADORA|\bTABLET\b|VENTILADOR|LICUADORA|PLANCHA|TOSTADOR|PARLANTE|AURICULAR|PAVA ELECTRICA|CAFETERA|ASPIRADORA|ZAPATILLA.{0,40}(MT|METROS|INTERRUPTOR|TOMAS)"),
    ("bazar", "Bazar y deco", r"\bGLOBO|\bSAHUMERIO|\bESFERAS?\b|\bPORTAVELA|\bVASO|\bPLATOS?\b|\bCUBIERTO|\bOLLA|\bSARTEN|\bTUPPER|\bORGANIZADOR|\bPERCHA|\bJUGUETE|\bPILAS?\b|HALLOWEEN|\bADORNO|\bDECORAC|\bBANDEJA|\bJARRA|\bJARRO|\bMUG\b|\bTAZA|\bBOWL|\bTENEDOR|\bCUCHILLO|\bCUCHARA|\bBOLSAS?\b|\bADHESIVO|MACETA"),
    ("textil", "Textil y hogar", r"\bTOALLON|\bSABANA|\bALMOHADON|\bFUNDA|\bACOLCHADO|\bMANTA|\bREPASADOR|\bREMERA|\bBERMUDA|\bPIJAMA|\bBOXER|\bMEDIAS|\bSANDALIA|\bZAPATILLA|\bBUZO|\bCAMPERA|\bPANTALON|\bCALZAS?\b|\bCONJUNTO|\bCAMISA|\bBLUSA|\bVESTIDO|\bPOLLERA|\bCORPINO|^HG "),
    ("construccion", "Construcción", r"CEMENTO|^CAL |LADRILLO|PINTURA|HIERRO|\bCERAMICA\b|PORCELANATO|YESO|\bARENA\b|MALLA|\bCHAPA\b|\bTUBO\b|\bCABLE\b|CANILLA|PEGAMENTO|\bTORNILLO|\bCLAVO|\bMARTILLO"),
]

FALLBACK = ("otros", "Otros")


def _case_sql() -> str:
    ramas = []
    for slug, _, patron in CATEGORIAS:
        ramas.append(f"WHEN regexp_matches(t, '{patron}') THEN '{slug}'")
    return "\n        ".join(ramas)


def construir() -> None:
    con = duckdb.connect()
    con.execute(f"CREATE VIEW p AS SELECT * FROM '{PRECIOS_PARQUET.as_posix()}'")

    case = _case_sql()
    con.execute(f"""
        CREATE OR REPLACE TABLE productos AS
        WITH base AS (
            SELECT
                ean,
                arg_max(nombre, length(nombre))                       AS nombre,
                arg_max(marca, coalesce(length(marca), 0))            AS marca,
                COUNT(DISTINCT id_comercio)                           AS n_cadenas,
                COUNT(DISTINCT suc_key)                               AS n_sucursales,
                MIN(precio_lista)                                     AS precio_min,
                MEDIAN(precio_lista)                                  AS precio_mediana,
                MAX(precio_lista)                                     AS precio_max,
                arg_min(bandera, precio_lista)                        AS mejor_bandera,
                arg_min(localidad, precio_lista)                      AS mejor_localidad,
                arg_min(precio_lista, precio_lista)                   AS mejor_precio
            FROM p
            GROUP BY ean
        )
        SELECT *,
            CASE
        {case}
                ELSE '{FALLBACK[0]}'
            END AS categoria,
            coalesce(nullif(upper(trim(marca)), 'SIN MARCA'), nullif(upper(trim(marca)), 'S/D'), nullif(upper(trim(marca)), 'GENERICO')) AS marca_limpia
        FROM (
            SELECT *, strip_accents(nombre) || ' ' || coalesce(strip_accents(marca), '') AS t
            FROM base
        )
    """)

    con.execute(
        f"COPY productos TO '{PRODUCTOS_PARQUET.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )

    print(f"{'categoría':24} {'productos':>10}")
    for slug, n in con.execute(
        "SELECT categoria, COUNT(*) FROM productos GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall():
        print(f"{slug:24} {n:10,}")


if __name__ == "__main__":
    construir()
