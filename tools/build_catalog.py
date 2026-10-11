"""
Builds content/catalog.json — the orderable catalog for Bedside Sim.

Each item: id, name, cat, syn (synonyms/misspellings for matching), tat (turnaround
in SIM minutes), price (USD, approximate Medicare reference), kind ('labs'|'text'),
default result (shown when a case has no specific result), act (True = an action the
instructor should react to: meds, procedures, vent changes).

Prices are rounded, approximate Medicare reference amounts (CMS Clinical Lab Fee
Schedule, Physician Fee Schedule, ASP drug pricing) for teaching cost awareness —
NOT hospital charges. Verify and update before citing them anywhere.
"""
import json
import os

ITEMS = []


def L(id, name, syn, tat, price, rows, cat="Labs"):
    ITEMS.append({"id": id, "name": name, "cat": cat, "syn": syn, "tat": tat, "price": price,
                  "kind": "labs", "default": [list(r) for r in rows]})


def T(id, name, syn, tat, price, text, cat, act=False):
    ITEMS.append({"id": id, "name": name, "cat": cat, "syn": syn, "tat": tat, "price": price,
                  "kind": "text", "default": text, **({"act": True} if act else {})})


def M(id, name, syn, price, note="Given.", cat="Medications"):
    T(id, name, syn, 2, price, note, cat, act=True)


# ---------------- LABS: hematology / chemistry ----------------
L("cbc", "CBC with differential", ["cbc", "complete blood count", "blood count", "hemogram", "h/h", "h&h", "hgb", "hemoglobin", "wbc", "platelets", "plt"], 30, 8,
  [("WBC", "8.2", "K/µL", ""), ("Hgb", "13.6", "g/dL", ""), ("Hct", "40.8", "%", ""), ("Plt", "245", "K/µL", ""), ("Neutrophils", "64", "%", ""), ("Lymphocytes", "26", "%", "")])
L("bmp", "Basic metabolic panel", ["bmp", "chem 7", "chem7", "chem-7", "basic metabolic", "lytes", "electrolytes", "renal function", "bun", "creatinine", "cr", "potassium", "sodium", "k+", "na"], 30, 8,
  [("Na", "139", "mmol/L", ""), ("K", "4.1", "mmol/L", ""), ("Cl", "103", "mmol/L", ""), ("HCO3", "25", "mmol/L", ""), ("BUN", "14", "mg/dL", ""), ("Creatinine", "0.9", "mg/dL", ""), ("Glucose", "104", "mg/dL", ""), ("Anion gap", "11", "", "")])
L("cmp", "Comprehensive metabolic panel", ["cmp", "chem 14", "comprehensive metabolic", "chem14"], 30, 10,
  [("Na", "139", "mmol/L", ""), ("K", "4.1", "mmol/L", ""), ("Cl", "103", "mmol/L", ""), ("HCO3", "25", "mmol/L", ""), ("BUN", "14", "mg/dL", ""), ("Creatinine", "0.9", "mg/dL", ""), ("Glucose", "104", "mg/dL", ""), ("Ca", "9.2", "mg/dL", ""), ("Albumin", "3.9", "g/dL", ""), ("AST", "24", "U/L", ""), ("ALT", "21", "U/L", ""), ("Alk phos", "78", "U/L", ""), ("T bili", "0.6", "mg/dL", "")])
L("mg", "Magnesium", ["magnesium level", "mg level", "serum mg", "serum magnesium"], 30, 7, [("Mg", "2.0", "mg/dL", "")])
L("phos", "Phosphorus", ["phos", "phosphate", "phosphorus level"], 30, 5, [("Phos", "3.4", "mg/dL", "")])
L("ica", "Ionized calcium", ["ionized calcium", "ica", "i-ca", "ionized ca"], 15, 14, [("iCa", "1.18", "mmol/L", "")])
L("lft", "Hepatic function panel", ["lft", "lfts", "liver function", "hepatic panel", "liver panel", "ast", "alt", "bilirubin"], 30, 8,
  [("AST", "24", "U/L", ""), ("ALT", "21", "U/L", ""), ("Alk phos", "78", "U/L", ""), ("T bili", "0.6", "mg/dL", ""), ("Albumin", "3.9", "g/dL", "")])
L("lipase", "Lipase", ["lipase", "amylase"], 30, 7, [("Lipase", "32", "U/L", "")])
L("ck", "Creatine kinase", ["ck", "cpk", "creatine kinase"], 30, 7, [("CK", "110", "U/L", "")])
L("ammonia", "Ammonia", ["ammonia", "nh3"], 30, 14, [("Ammonia", "28", "µmol/L", "")])
L("tsh", "TSH", ["tsh", "thyroid"], 60, 17, [("TSH", "1.8", "mIU/L", "")])
L("cortisol", "Cortisol, random", ["cortisol", "random cortisol"], 60, 16, [("Cortisol", "18", "µg/dL", "")])
L("osm", "Serum osmolality", ["osm", "osmolality", "serum osm", "osmolal gap"], 45, 7, [("Osmolality", "290", "mOsm/kg", "")])
L("bhb", "Beta-hydroxybutyrate", ["bhb", "beta hydroxybutyrate", "ketones", "serum ketones"], 30, 7, [("BHB", "0.2", "mmol/L", "")])
L("glucose_poc", "Point-of-care glucose", ["fingerstick", "finger stick", "poc glucose", "accucheck", "accu-check", "accuchek", "glucose check", "bedside glucose", "fsbg", "bg check"], 1, 3, [("Glucose (POC)", "112", "mg/dL", "")])
L("lactate", "Lactate", ["lactate", "lactic acid", "lactic", "lac", "serum lactate"], 15, 13, [("Lactate", "1.1", "mmol/L", "")])
L("procal", "Procalcitonin", ["procalcitonin", "pct", "procal"], 60, 28, [("Procalcitonin", "0.08", "ng/mL", "")])
L("crp", "C-reactive protein", ["crp", "c reactive protein"], 60, 5, [("CRP", "0.6", "mg/dL", "")])
L("trop", "Troponin (high-sensitivity)", ["troponin", "trop", "hs troponin", "hstrop", "hs-trop", "cardiac enzymes"], 45, 10, [("hs-Troponin T", "8", "ng/L", "")])
L("bnp", "BNP", ["bnp", "b-type natriuretic", "natriuretic peptide"], 45, 29, [("BNP", "42", "pg/mL", "")])
L("ntbnp", "NT-proBNP", ["nt-probnp", "nt pro bnp", "probnp", "ntprobnp"], 45, 17, [("NT-proBNP", "110", "pg/mL", "")])
L("ddimer", "D-dimer", ["d-dimer", "ddimer", "d dimer", "dimer"], 45, 10, [("D-dimer", "0.32", "µg/mL FEU", "")])
L("coags", "PT/INR and PTT", ["coags", "coag", "inr", "ptt", "aptt", "pt/inr", "coagulation", "coag panel", "coagulation panel"], 30, 10,
  [("PT", "12.8", "s", ""), ("INR", "1.0", "", ""), ("PTT", "29", "s", "")])
L("fibrinogen", "Fibrinogen", ["fibrinogen", "fibrin"], 30, 8, [("Fibrinogen", "320", "mg/dL", "")])
L("antixa", "Anti-Xa (heparin) level", ["anti xa", "anti-xa", "heparin level", "antixa"], 60, 18, [("Anti-Xa", "0.0", "IU/mL", "")])
L("tns", "Type and screen", ["type and screen", "type & screen", "t&s", "type and cross", "type & cross", "crossmatch", "cross match", "blood bank", "t and s"], 45, 20, [("ABO/Rh", "O positive", "", ""), ("Antibody screen", "Negative", "", "")])
L("hapto", "Hemolysis labs (LDH, haptoglobin, retic)", ["ldh", "haptoglobin", "hemolysis labs", "retic", "reticulocyte"], 60, 25,
  [("LDH", "180", "U/L", ""), ("Haptoglobin", "120", "mg/dL", ""), ("Reticulocytes", "1.2", "%", "")])
L("hcg", "hCG, quantitative", ["hcg", "beta hcg", "pregnancy test", "bhcg", "urine pregnancy"], 30, 15, [("hCG", "<2", "mIU/mL", "")])

# ---------------- LABS: blood gas ----------------
L("abg", "Arterial blood gas", ["abg", "arterial blood gas", "art gas", "blood gas", "gas", "arterial gas", "a gas", "abgs"], 10, 24,
  [("pH", "7.40", "", ""), ("PaCO2", "40", "mmHg", ""), ("PaO2", "92", "mmHg", ""), ("HCO3", "24", "mmol/L", ""), ("SaO2", "97", "%", "")], cat="Blood gas")
L("vbg", "Venous blood gas", ["vbg", "venous blood gas", "venous gas"], 10, 24,
  [("pH", "7.37", "", ""), ("PvCO2", "45", "mmHg", ""), ("HCO3", "25", "mmol/L", "")], cat="Blood gas")
L("cooxi", "Co-oximetry (COHb, MetHb)", ["co-oximetry", "cooximetry", "carboxyhemoglobin", "cohb", "methemoglobin", "methb", "co level"], 15, 15,
  [("COHb", "1.2", "%", ""), ("MetHb", "0.6", "%", "")], cat="Blood gas")

# ---------------- MICRO / ID ----------------
T("bcx", "Blood cultures x2", ["blood culture", "blood cultures", "bcx", "bc x2", "cultures", "blood cx"], 1440, 20, "No growth at 24 hours (preliminary).", "Microbiology")
T("ucx", "Urine culture", ["urine culture", "ucx", "urine cx"], 1440, 9, "No growth at 24 hours (preliminary).", "Microbiology")
T("sputum", "Sputum / tracheal aspirate culture and Gram stain", ["sputum culture", "sputum", "tracheal aspirate", "trach aspirate", "endotracheal aspirate", "gram stain", "resp culture", "respiratory culture"], 720, 13, "Gram stain: few PMNs, no organisms seen. Culture pending.", "Microbiology")
T("rvp", "Respiratory viral PCR panel (incl. influenza, RSV, SARS-CoV-2)", ["viral panel", "rvp", "respiratory panel", "resp viral panel", "flu", "influenza", "flu swab", "covid", "covid test", "sars-cov-2", "rsv", "viral pcr", "nasal swab", "respiratory pcr"], 60, 140, "Negative for influenza A/B, RSV, SARS-CoV-2 and other panel targets.", "Microbiology")
T("legionella", "Legionella and pneumococcal urine antigens", ["legionella", "urine antigen", "urine antigens", "strep pneumo antigen", "pneumococcal antigen", "legionella antigen"], 60, 26, "Legionella urinary antigen: negative. S. pneumoniae urinary antigen: negative.", "Microbiology")
T("mrsa", "MRSA nares PCR", ["mrsa nares", "mrsa swab", "mrsa pcr", "nasal mrsa", "mrsa screen"], 120, 40, "MRSA nares PCR: negative.", "Microbiology")
L("ua", "Urinalysis", ["ua", "urinalysis", "urine analysis", "urine dip", "dipstick"], 30, 3,
  [("Specific gravity", "1.015", "", ""), ("Nitrite", "Negative", "", ""), ("Leukocyte esterase", "Negative", "", ""), ("Protein", "Negative", "", ""), ("Blood", "Negative", "", "")])
L("utox", "Urine drug screen", ["utox", "urine tox", "urine drug screen", "uds", "tox screen", "drug screen"], 45, 15,
  [("Amphetamines", "Negative", "", ""), ("Cocaine", "Negative", "", ""), ("Opiates", "Negative", "", ""), ("Benzodiazepines", "Negative", "", "")])
L("stox", "Serum toxicology (EtOH, APAP, ASA)", ["serum tox", "ethanol", "etoh", "alcohol level", "acetaminophen level", "tylenol level", "apap", "salicylate", "asa level", "aspirin level"], 45, 33,
  [("Ethanol", "<10", "mg/dL", ""), ("Acetaminophen", "<10", "µg/mL", ""), ("Salicylate", "<4", "mg/dL", "")])
T("bal_studies", "BAL studies (cell count, culture, cytology)", ["bal studies", "bal cell count", "bal culture", "lavage studies"], 720, 120, "Cell count and culture pending; cytology pending.", "Microbiology")
T("pleural_fluid", "Pleural fluid studies (cell count, LDH, protein, pH, Gram stain, culture)", ["pleural fluid", "pleural studies", "light's criteria", "thoracentesis studies", "pleural ph"], 120, 60, "Pending.", "Microbiology")

# ---------------- IMAGING ----------------
T("cxr", "Chest X-ray, portable", ["cxr", "chest x-ray", "chest xray", "chest x ray", "chest film", "portable chest", "chest radiograph", "pcxr", "x-ray chest", "xray"], 15, 28, "Lungs clear. No effusion or pneumothorax. Normal cardiomediastinal silhouette. Lines and tubes: none.", "Imaging")
T("ct_head", "CT head without contrast", ["ct head", "head ct", "cth", "noncon head", "ct brain"], 45, 110, "No acute intracranial abnormality.", "Imaging")
T("ct_chest", "CT chest without contrast", ["ct chest", "chest ct", "ct chest without contrast", "noncontrast chest ct", "ct thorax"], 45, 140, "No consolidation, mass or effusion. No pneumothorax.", "Imaging")
T("cta_chest", "CT angiogram chest (PE protocol)", ["cta chest", "ct angiogram", "ctpa", "cta", "ct angio", "ct angio chest", "angio chest", "pe protocol", "ct pe", "pe study", "ct pulmonary angiogram", "cta pe"], 45, 230, "No pulmonary embolism. No acute thoracic abnormality.", "Imaging")
T("ct_ap", "CT abdomen/pelvis with contrast", ["ct abdomen", "ct a/p", "ct abd pelvis", "ct abd/pelvis", "abdominal ct"], 60, 260, "No acute abdominal or pelvic abnormality.", "Imaging")
T("ct_neck", "CT neck soft tissue with contrast", ["ct neck", "neck ct", "soft tissue neck"], 45, 160, "No airway narrowing, abscess or mass.", "Imaging")
T("lus", "Bedside lung ultrasound (POCUS)", ["lung ultrasound", "lung us", "pocus lung", "lung pocus", "blue protocol", "lung sliding", "thoracic ultrasound", "chest ultrasound", "pocus"], 5, 60, "Bilateral lung sliding, A-line pattern, no B-lines, no effusion.", "Imaging")
T("echo_pocus", "Bedside echo (POCUS, limited)", ["bedside echo", "pocus echo", "cardiac pocus", "limited echo", "focused echo", "rush exam", "rush", "fast exam"], 5, 105, "Normal LV and RV size and function. No pericardial effusion. IVC 1.8 cm, ~40% collapsibility.", "Imaging")
T("tte", "Transthoracic echocardiogram (formal)", ["tte", "echo", "echocardiogram", "transthoracic echo", "formal echo", "2d echo", "cardiac echo"], 120, 210, "LVEF 60%. Normal RV size and function. No significant valvular disease. No pericardial effusion.", "Imaging")
T("le_duplex", "Lower extremity venous duplex", ["le duplex", "leg ultrasound", "dvt study", "venous duplex", "lower extremity doppler", "dvt ultrasound", "leg doppler", "le dopplers"], 90, 200, "No deep venous thrombosis bilaterally.", "Imaging")
T("ecg", "12-lead ECG", ["ecg", "ekg", "12 lead", "12-lead", "electrocardiogram", "12 lead ecg"], 5, 16, "Sinus rhythm, normal axis, normal intervals, no acute ST changes.", "Cardiac")

# ---------------- RESPIRATORY / VENT ----------------
T("o2_nc", "Oxygen by nasal cannula", ["nasal cannula", "nc", "o2", "oxygen", "supplemental oxygen", "2l", "4l", "nasal o2"], 1, 0, "Started.", "Respiratory", act=True)
T("o2_nrb", "Non-rebreather mask", ["non-rebreather", "nonrebreather", "nrb", "15l nrb", "face mask", "100% mask"], 1, 0, "Started.", "Respiratory", act=True)
T("hfnc", "High-flow nasal cannula", ["hfnc", "high flow", "high-flow", "heated high flow", "optiflow", "airvo", "vapotherm"], 2, 120, "Started.", "Respiratory", act=True)
T("niv", "Noninvasive ventilation (BiPAP/CPAP)", ["bipap", "bi-pap", "niv", "nippv", "cpap", "noninvasive", "non-invasive", "nppv"], 2, 160, "Started.", "Respiratory", act=True)
T("vent_settings", "Ventilator setting change", ["change vent", "vent settings", "increase peep", "decrease peep", "peep", "fio2", "tidal volume", "decrease tidal volume", "lower tidal volume", "increase rate", "decrease rate", "respiratory rate", "i:e", "inspiratory time", "ventilator", "lung protective", "6 ml/kg", "ardsnet", "pressure control", "volume control", "set rate"], 1, 0, "Instructor will apply the requested settings.", "Respiratory", act=True)
T("plateau", "Inspiratory hold (plateau pressure)", ["plateau", "plateau pressure", "pplat", "inspiratory hold", "insp hold", "inspiratory pause"], 1, 0, "Measured on the vent — see monitor.", "Respiratory", act=True)
T("autopeep", "Expiratory hold (auto-PEEP)", ["auto-peep", "autopeep", "intrinsic peep", "expiratory hold", "exp hold", "expiratory pause"], 1, 0, "Measured on the vent — see monitor.", "Respiratory", act=True)
T("disconnect", "Disconnect from ventilator / bag manually", ["disconnect", "bag the patient", "bag him", "bag her", "manual ventilation", "bvm", "ambu", "take off the vent", "disconnect from vent", "dopes"], 1, 0, "Done.", "Respiratory", act=True)
T("suction", "Endotracheal suction / check tube", ["suction", "suction the tube", "pass suction catheter", "check tube", "inline suction", "check ett"], 1, 0, "Done.", "Respiratory", act=True)
T("sbt", "Spontaneous breathing trial", ["sbt", "spontaneous breathing trial", "breathing trial", "cpap trial", "ps trial", "t-piece"], 30, 0, "Instructor will report SBT tolerance.", "Respiratory", act=True)
T("cuff_leak", "Cuff leak test", ["cuff leak", "cuff-leak", "leak test"], 5, 0, "Audible cuff leak present.", "Respiratory", act=True)
T("prone", "Prone positioning", ["prone", "proning", "prone position", "flip prone", "prone him", "prone her"], 15, 0, "Patient proned.", "Respiratory", act=True)
T("ino", "Inhaled nitric oxide", ["inhaled nitric oxide", "ino", "nitric oxide", "nitric"], 5, 3000, "Started at 20 ppm.", "Respiratory", act=True)
T("inh_epo", "Inhaled epoprostenol", ["inhaled epoprostenol", "inhaled flolan", "veletri inhaled", "inhaled prostacyclin", "ifl"], 5, 300, "Started.", "Respiratory", act=True)
T("heliox", "Heliox", ["heliox", "helium"], 5, 150, "Started.", "Respiratory", act=True)
T("rt_eval", "Respiratory therapy evaluate and treat", ["rt eval", "respiratory therapy", "rt consult", "call rt"], 10, 0, "RT at bedside.", "Respiratory", act=True)

# ---------------- PROCEDURES ----------------
T("intubate", "Endotracheal intubation (RSI)", ["intubate", "intubation", "rsi", "ett", "endotracheal", "tube him", "tube her", "secure airway", "definitive airway", "airway"], 5, 130, "Intubated. Instructor will confirm tube position and post-intubation status.", "Procedures", act=True)
T("extubate", "Extubation", ["extubate", "extubation", "pull the tube", "remove tube"], 2, 0, "Extubated.", "Procedures", act=True)
T("cvc", "Central venous catheter", ["central line", "cvc", "central venous", "cordis", "triple lumen", "ij line", "subclavian line", "femoral line"], 15, 140, "Placed.", "Procedures", act=True)
T("aline", "Arterial line", ["art line", "arterial line", "a-line", "aline", "radial line"], 10, 55, "Placed. Arterial waveform on monitor.", "Procedures", act=True)
T("needle_d", "Needle / finger thoracostomy (decompression)", ["needle decompression", "needle thoracostomy", "finger thoracostomy", "decompress", "decompression", "needle the chest", "simple thoracostomy", "needle dart"], 1, 170, "Done.", "Procedures", act=True)
T("chest_tube", "Chest tube", ["chest tube", "thoracostomy tube", "tube thoracostomy", "pigtail", "ct placement"], 15, 190, "Placed to suction.", "Procedures", act=True)
T("thoracentesis", "Thoracentesis", ["thoracentesis", "tap the effusion", "pleural tap"], 20, 180, "Done.", "Procedures", act=True)
T("bronch", "Bronchoscopy (diagnostic/therapeutic)", ["bronchoscopy", "bronch", "bronchoscope", "fob", "therapeutic bronch"], 20, 180, "Instructor will report findings.", "Procedures", act=True)
T("bblocker", "Bronchial blocker / selective mainstem intubation", ["bronchial blocker", "endobronchial blocker", "arndt", "uniblocker", "mainstem intubation", "selective intubation", "double lumen", "dlt", "lung isolation"], 15, 200, "Instructor will confirm lung isolation.", "Procedures", act=True)
T("cardioversion", "Synchronized cardioversion", ["cardioversion", "cardiovert", "synchronized", "sync shock"], 1, 160, "Done.", "Procedures", act=True)
T("defib", "Defibrillation", ["defibrillate", "defib", "unsynchronized", "200j", "200 joules"], 1, 0, "Done.", "Procedures", act=True)
T("cpr", "CPR / ACLS", ["cpr", "compressions", "start compressions", "acls", "code blue", "call a code", "cardiac arrest"], 1, 170, "Started.", "Procedures", act=True)
T("ogt", "Orogastric tube", ["og tube", "ogt", "orogastric", "ng tube", "ngt", "nasogastric"], 5, 40, "Placed.", "Procedures", act=True)
T("foley", "Urinary catheter", ["foley", "urinary catheter", "bladder catheter", "strict i/o"], 5, 20, "Placed.", "Procedures", act=True)
T("ecmo", "ECMO consult / cannulation", ["ecmo", "vv ecmo", "va ecmo", "ecmo team", "extracorporeal"], 60, 0, "ECMO team notified; will evaluate.", "Consults", act=True)

# ---------------- MEDICATIONS ----------------
M("propofol", "Propofol infusion", ["propofol", "diprivan"], 5)
M("sedation", "Sedation (agent not specified)", ["sedation", "sedate", "sedative", "sedation infusion"], 5, "Started — instructor may ask which agent and target RASS.")
M("analgesia", "Analgesia (agent not specified)", ["analgesia", "pain control", "analgesic", "pain medication", "pain meds", "analgosedation"], 2, "Given — instructor may ask which agent.")
M("fentanyl", "Fentanyl", ["fentanyl", "fent"], 2)
M("hydromorphone", "Hydromorphone", ["hydromorphone", "dilaudid"], 2)
M("midazolam", "Midazolam", ["midazolam", "versed"], 1)
M("dexmed", "Dexmedetomidine infusion", ["dexmedetomidine", "precedex"], 40)
M("ketamine", "Ketamine", ["ketamine", "ketamine push", "ketamine infusion"], 5)
M("etomidate", "Etomidate", ["etomidate", "amidate"], 5)
M("roc", "Rocuronium", ["rocuronium", "roc", "zemuron"], 15)
M("sux", "Succinylcholine", ["succinylcholine", "sux", "anectine"], 8)
M("cisatra", "Cisatracurium infusion (neuromuscular blockade)", ["cisatracurium", "nimbex", "paralytic", "paralyze", "paralysis", "nmb", "neuromuscular blockade", "paralytic infusion"], 30)
M("norepi", "Norepinephrine infusion", ["norepinephrine", "norepi", "levophed", "levo", "pressor", "pressors", "vasopressor"], 15)
M("vaso", "Vasopressin infusion", ["vasopressin", "vaso", "pitressin"], 100)
M("epi_inf", "Epinephrine infusion", ["epinephrine drip", "epi drip", "epinephrine infusion", "epi infusion"], 10)
M("epi_push", "Epinephrine 1 mg IV push", ["epi 1mg", "epinephrine 1 mg", "push epi", "code epi", "epinephrine push", "epi push", "epinephrine"], 3)
M("pushdose", "Push-dose phenylephrine / epinephrine", ["push dose", "push-dose", "phenylephrine", "neo", "neosynephrine", "push dose epi", "push dose pressor"], 5)
M("dobutamine", "Dobutamine infusion", ["dobutamine", "dobut"], 10)
M("milrinone", "Milrinone infusion", ["milrinone"], 20)
M("albuterol", "Albuterol nebulizer / MDI", ["albuterol", "neb", "nebs", "duoneb", "nebulizer", "bronchodilator", "continuous neb", "salbutamol", "ventolin"], 1)
M("ipratropium", "Ipratropium nebulizer", ["ipratropium", "atrovent", "duoneb"], 1)
M("methylpred", "Methylprednisolone", ["methylprednisolone", "solumedrol", "solu-medrol", "steroids", "steroid", "solu medrol", "prednisone", "dexamethasone", "hydrocortisone"], 5)
M("mag", "Magnesium sulfate 2 g IV", ["magnesium sulfate", "mag sulfate", "magnesium 2g", "iv magnesium", "mag 2g", "give magnesium", "mgso4"], 5)
M("terbutaline", "Terbutaline SC", ["terbutaline"], 10)
M("ceftriaxone", "Ceftriaxone", ["ceftriaxone", "rocephin"], 2)
M("cefepime", "Cefepime", ["cefepime", "maxipime"], 8)
M("piptazo", "Piperacillin-tazobactam", ["piperacillin", "pip-tazo", "pip tazo", "zosyn", "piptazo"], 10)
M("meropenem", "Meropenem", ["meropenem", "merrem"], 15)
M("vanc", "Vancomycin", ["vancomycin", "vanc", "vanco"], 5)
M("linezolid", "Linezolid", ["linezolid", "zyvox"], 30)
M("azithro", "Azithromycin", ["azithromycin", "azithro", "zithromax"], 3)
M("doxy", "Doxycycline", ["doxycycline", "doxy"], 10)
M("oseltamivir", "Oseltamivir", ["oseltamivir", "tamiflu"], 15)
M("abx_broad", "Broad-spectrum antibiotics (unspecified)", ["antibiotics", "abx", "broad spectrum", "broad-spectrum", "empiric antibiotics"], 10, "Given — instructor may ask which agents.")
M("heparin", "Heparin infusion", ["heparin", "heparin drip", "ufh", "anticoagulation", "anticoagulate"], 10)
M("enox", "Enoxaparin", ["enoxaparin", "lovenox", "lmwh"], 10)
M("tpa", "Alteplase (systemic thrombolysis)", ["alteplase", "tpa", "t-pa", "thrombolysis", "thrombolytic", "lytics", "tnk", "tenecteplase", "systemic lysis"], 9000)
M("txa", "Tranexamic acid", ["tranexamic acid", "txa", "cyklokapron"], 15)
M("nebtxa", "Nebulized tranexamic acid", ["nebulized txa", "neb txa", "inhaled txa"], 15)
M("lr", "Lactated Ringer's bolus", ["lactated ringer", "lactated ringers", "lr", "lr bolus", "fluid bolus", "bolus", "ivf", "iv fluids", "fluids", "crystalloid", "30 ml/kg", "30ml/kg"], 2)
M("ns", "Normal saline bolus", ["normal saline", "ns", "saline", "0.9%", "ns bolus"], 2)
M("albumin", "Albumin 5%", ["albumin"], 50)
M("prbc", "Packed red blood cells, 1 unit", ["prbc", "prbcs", "packed red", "transfuse", "transfusion", "blood transfusion", "rbc", "unit of blood", "give blood"], 220)
M("ffp", "Fresh frozen plasma", ["ffp", "plasma", "fresh frozen plasma"], 60)
M("plt_tx", "Platelets, 1 unit", ["platelet transfusion", "transfuse platelets", "plt transfusion", "give platelets"], 500)
M("mtp", "Massive transfusion protocol", ["mtp", "massive transfusion", "massive transfusion protocol"], 1500)
M("furosemide", "Furosemide", ["furosemide", "lasix", "diuresis", "diurese", "diuretic"], 2)
M("nitro", "Nitroglycerin", ["nitroglycerin", "nitro", "ntg"], 10)
M("amio", "Amiodarone", ["amiodarone", "amio"], 10)
M("diltiazem", "Diltiazem", ["diltiazem", "cardizem", "dilt"], 5)
M("metoprolol", "Metoprolol IV", ["metoprolol", "lopressor", "beta blocker"], 2)
M("adenosine", "Adenosine", ["adenosine"], 10)
M("atropine", "Atropine", ["atropine"], 5)
M("calcium", "Calcium chloride / gluconate", ["calcium chloride", "calcium gluconate", "cacl", "give calcium"], 5)
M("bicarb", "Sodium bicarbonate", ["bicarbonate", "bicarb", "sodium bicarb", "nahco3"], 5)
M("insulin_dex", "Insulin + dextrose (hyperkalemia)", ["insulin and dextrose", "insulin dextrose", "insulin d50", "shift potassium"], 5)
M("insulin_inf", "Insulin infusion", ["insulin drip", "insulin infusion", "insulin gtt"], 10)
M("d50", "Dextrose 50%", ["d50", "dextrose", "amp of d50"], 3)
M("naloxone", "Naloxone", ["naloxone", "narcan"], 25)
M("ondansetron", "Ondansetron", ["ondansetron", "zofran"], 1)
M("ppi", "Pantoprazole IV", ["pantoprazole", "protonix", "ppi"], 3)
M("octreotide", "Octreotide infusion", ["octreotide", "sandostatin"], 40)
M("acetaminophen", "Acetaminophen", ["acetaminophen", "tylenol", "apap", "paracetamol"], 1)

# ---------------- NURSING / CONSULTS ----------------
T("hob", "Head of bed 30°", ["hob", "head of bed", "elevate head", "raise head of bed"], 1, 0, "Done.", "Nursing", act=True)
T("position_bleed", "Position bleeding side down", ["bleeding side down", "lateral decubitus", "bad lung down", "affected side down", "position side down"], 1, 0, "Done.", "Nursing", act=True)
T("restraints", "Soft restraints", ["restraints", "soft restraints"], 1, 0, "Applied.", "Nursing", act=True)
T("cont_monitor", "Continuous pulse oximetry and telemetry", ["telemetry", "tele", "continuous pulse ox", "cardiac monitor", "monitor"], 1, 0, "On monitor.", "Nursing")
T("iv_access", "Large-bore IV access x2", ["iv access", "large bore", "2 large bore", "two large bore", "piv", "peripheral iv", "18g", "16g"], 3, 15, "Two large-bore IVs placed.", "Nursing", act=True)
T("io_access", "Intraosseous access", ["io", "intraosseous", "io access"], 2, 60, "IO placed.", "Nursing", act=True)
T("c_pulm", "Pulmonary / critical care consult", ["pulm consult", "pulmonary consult", "pccm consult", "icu consult", "micu consult", "critical care consult", "consult icu"], 15, 0, "Consultant on the way.", "Consults", act=True)
T("c_ip", "Interventional pulmonology consult", ["ip consult", "interventional pulmonology", "interventional pulm"], 30, 0, "IP will see the patient.", "Consults", act=True)
T("c_ir", "Interventional radiology consult (embolization)", ["ir consult", "interventional radiology", "embolization", "bronchial artery embolization", "bae"], 30, 0, "IR notified; reviewing imaging.", "Consults", act=True)
T("c_cards", "Cardiology consult", ["cardiology consult", "cards consult", "cardiology"], 30, 0, "Cardiology notified.", "Consults", act=True)
T("c_pert", "PE response team (PERT)", ["pert", "pe response team", "pulmonary embolism response"], 15, 0, "PERT activated.", "Consults", act=True)
T("c_ts", "Thoracic surgery consult", ["thoracic surgery", "cardiothoracic surgery", "ct surgery", "ts consult"], 30, 0, "Thoracic surgery notified.", "Consults", act=True)
T("c_anes", "Anesthesia / difficult airway team", ["anesthesia", "difficult airway", "airway team", "call anesthesia"], 10, 0, "Anesthesia en route.", "Consults", act=True)
T("c_ent", "ENT consult", ["ent", "ent consult", "otolaryngology"], 30, 0, "ENT notified.", "Consults", act=True)
T("c_gi", "GI consult (endoscopy)", ["gi consult", "gastroenterology", "egd", "endoscopy"], 30, 0, "GI notified.", "Consults", act=True)
T("c_palliative", "Palliative care / goals of care", ["palliative", "goals of care", "code status", "family meeting"], 60, 0, "Palliative care will see the patient.", "Consults", act=True)

SETS = [
    ("set_icu_adm", "ICU admission labs", ["cbc", "bmp", "mg", "phos", "coags", "lactate", "tns", "abg", "cxr", "ecg"]),
    ("set_sepsis", "Sepsis bundle (1 hour)", ["bcx", "lactate", "abx_broad", "lr", "cbc", "cmp", "procal", "ua", "ucx", "cxr"]),
    ("set_rsi", "Rapid sequence intubation", ["intubate", "etomidate", "ketamine", "roc", "pushdose", "ogt", "cxr", "abg"]),
    ("set_postint", "Post-intubation bundle", ["cxr", "abg", "propofol", "fentanyl", "ogt", "hob", "plateau", "sputum"]),
    ("set_ards", "ARDS / lung-protective ventilation", ["vent_settings", "plateau", "abg", "cisatra", "prone", "echo_pocus", "furosemide"]),
    ("set_asthma", "Severe asthma exacerbation", ["albuterol", "ipratropium", "methylpred", "mag", "abg", "cxr", "terbutaline", "heliox"]),
    ("set_copd", "COPD exacerbation", ["albuterol", "ipratropium", "methylpred", "azithro", "niv", "abg", "cxr", "rvp"]),
    ("set_hypox", "Acute hypoxemia work-up", ["abg", "cxr", "lus", "echo_pocus", "ecg", "bnp", "trop", "ddimer"]),
    ("set_pe", "Suspected PE", ["cta_chest", "echo_pocus", "le_duplex", "trop", "bnp", "heparin", "c_pert", "ecg"]),
    ("set_hemoptysis", "Massive hemoptysis", ["position_bleed", "iv_access", "tns", "coags", "cbc", "bblocker", "bronch", "c_ir", "cta_chest", "nebtxa"]),
    ("set_ptx", "Suspected tension pneumothorax", ["disconnect", "needle_d", "chest_tube", "lus", "cxr", "abg"]),
    ("set_extub", "Extubation readiness", ["sbt", "cuff_leak", "abg", "cxr", "methylpred"]),
    ("set_mtp", "Massive transfusion", ["mtp", "tns", "coags", "fibrinogen", "ica", "cbc", "txa", "calcium"]),
    ("set_pah", "Pulmonary hypertension crisis", ["echo_pocus", "ino", "inh_epo", "norepi", "vaso", "dobutamine", "abg", "c_cards"]),
    ("set_pneumonia", "Severe pneumonia", ["bcx", "sputum", "rvp", "legionella", "mrsa", "procal", "ceftriaxone", "azithro", "vanc", "cxr"]),
]


def main():
    ids = {i["id"] for i in ITEMS}
    assert len(ids) == len(ITEMS), "duplicate ids"
    for sid, _, members in SETS:
        missing = [m for m in members if m not in ids]
        assert not missing, (sid, missing)
    out = {
        "version": 1,
        "priceNote": "Approximate Medicare reference prices (CMS fee schedules), rounded; for cost awareness, not hospital charges.",
        "items": ITEMS,
        "sets": [{"id": s, "name": n, "items": m} for s, n, m in SETS],
    }
    here = os.path.dirname(os.path.abspath(__file__))
    dest = os.path.join(here, "..", "content", "catalog.json")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as f:
        json.dump(out, f, indent=1)
    print(f"{len(ITEMS)} items, {len(SETS)} order sets -> {os.path.normpath(dest)}")


if __name__ == "__main__":
    main()
