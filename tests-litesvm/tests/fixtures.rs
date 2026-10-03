//! Cross-language check of the contract v0.1 fixtures (docs/CONTRACT.md §11).
//!
//! Re-derives every PDA in test/fixtures/pda.json with
//! `Address::find_program_address`, so the Rust side agrees with the
//! JavaScript generator (scripts/contract/gen-fixtures.mjs) and the SDK.
//! It also checks that the fixtures' program id is the suite's
//! `PROGRAM_ID` (the program's `declare_id!`), and that the placeholder
//! vectors are the §2.4 table.
//!
//! This crate has no JSON dependency, and a new crate would hit the 7-day
//! crate-age hold, so the file is read with the small parser below. It
//! accepts the JSON the generator writes: objects, arrays, ASCII strings,
//! integers, booleans and null. Nothing here needs the program artifact.

use gogocash_cashback_litesvm_tests as fx;
use solana_address::Address;
use std::path::PathBuf;

/// test/fixtures/pda.json, relative to this crate's directory.
const PDA_FIXTURE: &str = "../test/fixtures/pda.json";

const BASE58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ---------------------------------------------------------------------------
// Minimal JSON reader
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
enum Json {
    Null,
    Bool(bool),
    Number(String),
    Str(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> &Json {
        let Json::Object(members) = self else {
            panic!("expected a JSON object around key {key}");
        };
        let found = members.iter().find(|(name, _)| name == key);
        let Some((_, value)) = found else {
            panic!("missing JSON key {key}");
        };
        value
    }

    fn as_str(&self) -> &str {
        let Json::Str(text) = self else {
            panic!("expected a JSON string, got {self:?}");
        };
        text
    }

    fn as_opt_str(&self) -> Option<&str> {
        match self {
            Json::Null => None,
            other => Some(other.as_str()),
        }
    }

    fn as_array(&self) -> &[Json] {
        let Json::Array(items) = self else {
            panic!("expected a JSON array, got {self:?}");
        };
        items
    }

    fn as_u8(&self) -> u8 {
        let Json::Number(text) = self else {
            panic!("expected a JSON number, got {self:?}");
        };
        let parsed = text.parse();
        parsed.unwrap_or_else(|_| panic!("not a u8: {text}"))
    }

    fn as_bool(&self) -> bool {
        let Json::Bool(value) = self else {
            panic!("expected a JSON boolean, got {self:?}");
        };
        *value
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

fn parse_json(text: &str) -> Json {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        pos: 0,
    };
    let value = parser.value();
    parser.skip_whitespace();
    assert_eq!(parser.pos, parser.bytes.len(), "trailing JSON text");
    value
}

impl Parser<'_> {
    fn peek(&self) -> u8 {
        let Some(byte) = self.bytes.get(self.pos) else {
            panic!("unexpected end of JSON at byte {}", self.pos);
        };
        *byte
    }

    fn take_byte(&mut self) -> u8 {
        let byte = self.peek();
        self.pos += 1;
        byte
    }

    fn expect_byte(&mut self, expected: u8) {
        let found = self.take_byte();
        let at = self.pos - 1;
        assert_eq!(found, expected, "unexpected JSON byte at {at}");
    }

    fn skip_whitespace(&mut self) {
        while let Some(b' ' | b'\n' | b'\r' | b'\t') = self.bytes.get(self.pos) {
            self.pos += 1;
        }
    }

    fn value(&mut self) -> Json {
        self.skip_whitespace();
        match self.peek() {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => Json::Str(self.string()),
            b't' => self.literal("true", Json::Bool(true)),
            b'f' => self.literal("false", Json::Bool(false)),
            b'n' => self.literal("null", Json::Null),
            _ => self.number(),
        }
    }

    fn literal(&mut self, word: &str, value: Json) -> Json {
        let end = self.pos + word.len();
        assert_eq!(self.bytes.get(self.pos..end), Some(word.as_bytes()));
        self.pos = end;
        value
    }

    fn number(&mut self) -> Json {
        let start = self.pos;
        while let Some(b'-' | b'0'..=b'9') = self.bytes.get(self.pos) {
            self.pos += 1;
        }
        assert!(self.pos > start, "invalid JSON value at byte {start}");
        let digits = &self.bytes[start..self.pos];
        Json::Number(String::from_utf8_lossy(digits).into_owned())
    }

    fn string(&mut self) -> String {
        self.expect_byte(b'"');
        let mut out = String::new();
        loop {
            let byte = self.take_byte();
            match byte {
                b'"' => return out,
                b'\\' => out.push(self.escape()),
                _ => {
                    assert!(byte.is_ascii(), "the fixtures are ASCII only");
                    out.push(char::from(byte));
                }
            }
        }
    }

    fn escape(&mut self) -> char {
        match self.take_byte() {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            other => panic!("unsupported JSON escape {}", char::from(other)),
        }
    }

    fn array(&mut self) -> Json {
        self.expect_byte(b'[');
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == b']' {
            self.pos += 1;
            return Json::Array(items);
        }
        loop {
            items.push(self.value());
            self.skip_whitespace();
            match self.take_byte() {
                b',' => {}
                b']' => return Json::Array(items),
                other => panic!("unexpected {} in a JSON array", char::from(other)),
            }
        }
    }

    fn object(&mut self) -> Json {
        self.expect_byte(b'{');
        let mut members = Vec::new();
        self.skip_whitespace();
        if self.peek() == b'}' {
            self.pos += 1;
            return Json::Object(members);
        }
        loop {
            self.skip_whitespace();
            let key = self.string();
            self.skip_whitespace();
            self.expect_byte(b':');
            members.push((key, self.value()));
            self.skip_whitespace();
            match self.take_byte() {
                b',' => {}
                b'}' => return Json::Object(members),
                other => panic!("unexpected {} in a JSON object", char::from(other)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn pda_vectors() -> Vec<Json> {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path = crate_dir.join(PDA_FIXTURE);
    let text = std::fs::read_to_string(&path);
    let text = text.unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()));
    let document = parse_json(&text);
    assert_eq!(document.get("contract").as_str(), "v0");
    assert_eq!(document.get("file").as_str(), "pda.json");
    let vectors = document.get("vectors").as_array().to_vec();
    assert!(!vectors.is_empty(), "pda.json has no vectors");
    vectors
}

fn find_vector<'a>(vectors: &'a [Json], id: &str) -> &'a Json {
    let found = vectors.iter().find(|v| v.get("id").as_str() == id);
    let Some(vector) = found else {
        panic!("pda.json has no vector named {id}");
    };
    vector
}

fn bytes32(bytes: &[u8]) -> [u8; 32] {
    let Ok(array) = <[u8; 32]>::try_from(bytes) else {
        panic!("expected 32 bytes, got {}", bytes.len());
    };
    array
}

fn address_from_bytes(bytes: &[u8]) -> Address {
    Address::new_from_array(bytes32(bytes))
}

/// Decodes a base58 address (Bitcoin alphabet; each leading `1` is one zero
/// byte) without relying on an optional `solana-address` feature.
fn address_from_base58(text: &str) -> Address {
    // Little-endian base-256 digits of the value.
    let mut value: Vec<u8> = Vec::new();
    for symbol in text.bytes() {
        let digit = BASE58_ALPHABET.iter().position(|&a| a == symbol);
        let Some(digit) = digit else {
            panic!("invalid base58 character in {text}");
        };
        let mut carry = digit as u32;
        for byte in value.iter_mut() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            value.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = text.bytes().take_while(|&symbol| symbol == b'1').count();
    value.resize(value.len() + zeros, 0);
    value.reverse();
    address_from_bytes(&value)
}

fn vector_seeds(vector: &Json) -> Vec<Vec<u8>> {
    let mut seeds = Vec::new();
    for seed in vector.get("seeds").as_array() {
        seeds.push(fx::hex_decode(seed.as_str()));
    }
    seeds
}

fn expected_pda(vector: &Json) -> (Address, u8) {
    let address = address_from_base58(vector.get("address").as_str());
    (address, vector.get("bump").as_u8())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn the_base58_reader_agrees_with_the_address_macro() {
    let program = address_from_base58("HWNF2cvXybfAjLbw2pydi7sNFmTfYBjpEWNtY3BJfCje");
    assert_eq!(program, fx::PROGRAM_ID);
    let token = address_from_base58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    assert_eq!(token, fx::TOKEN_PROGRAM_ID);
    let loader = address_from_base58("BPFLoaderUpgradeab1e11111111111111111111111");
    assert_eq!(loader, fx::LOADER_V3_ID);
    let system = address_from_base58("11111111111111111111111111111111");
    assert_eq!(system, fx::SYSTEM_PROGRAM_ID);
}

#[test]
fn every_pda_vector_rederives_with_find_program_address() {
    for vector in &pda_vectors() {
        let id = vector.get("id").as_str();
        let derive_program = address_from_base58(vector.get("derive_program").as_str());
        let seeds = vector_seeds(vector);
        let seed_refs: Vec<&[u8]> = seeds.iter().map(Vec::as_slice).collect();
        let derived = Address::find_program_address(&seed_refs, &derive_program);
        assert_eq!(derived, expected_pda(vector), "{id}: pda.json disagrees");
    }
}

#[test]
fn pda_vectors_use_the_suite_program_id_and_match_its_helpers() {
    for vector in &pda_vectors() {
        let id = vector.get("id").as_str();
        let program_id = address_from_base58(vector.get("program_id").as_str());
        assert_eq!(program_id, fx::PROGRAM_ID, "{id}: program id");
        let status = vector.get("program_status").as_str();
        // Every vector is under the devnet program id slot. The mainnet id is
        // unassigned, so the §2.4 mainnet column is keyed by the mint.
        let cluster = vector.get("cluster").as_str();
        assert_eq!(cluster, "devnet", "{id}: cluster");
        let mint_cluster = vector.get("mint_cluster").as_opt_str();
        let is_program_data = vector.get("kind").as_str() == "program_data";
        assert_eq!(
            mint_cluster.is_none(),
            is_program_data,
            "{id}: mint_cluster"
        );
        let other_mint = mint_cluster.is_some_and(|mint| mint != cluster);
        let derivation_only = vector.get("derivation_only").as_bool();
        let expected_only = status == "placeholder" || other_mint;
        assert_eq!(derivation_only, expected_only, "{id}: derivation_only");
        let derive_program = address_from_base58(vector.get("derive_program").as_str());
        let seeds = vector_seeds(vector);
        let expected = expected_pda(vector);
        match vector.get("kind").as_str() {
            "program_data" => {
                assert_eq!(derive_program, fx::LOADER_V3_ID, "{id}");
                let derived = fx::program_data_pda(&program_id);
                assert_eq!(derived, expected, "{id}: program_data_pda");
            }
            "vault" => {
                assert_eq!(derive_program, fx::PROGRAM_ID, "{id}");
                assert_eq!(seeds[0], b"vault", "{id}: vault seed");
                let mint = address_from_bytes(&seeds[1]);
                assert_eq!(fx::vault_pda(&mint), expected, "{id}: vault_pda");
            }
            "receipt" => {
                assert_eq!(derive_program, fx::PROGRAM_ID, "{id}");
                assert_eq!(seeds[0], b"receipt", "{id}: receipt seed");
                let vault = address_from_bytes(&seeds[1]);
                let payout_id = bytes32(&seeds[2]);
                let derived = fx::receipt_pda(&vault, &payout_id);
                assert_eq!(derived, expected, "{id}: receipt_pda");
            }
            "associated_token_account" => {
                assert_eq!(derive_program, fx::ATA_PROGRAM_ID, "{id}");
                let token_program = address_from_bytes(&seeds[1]);
                assert_eq!(token_program, fx::TOKEN_PROGRAM_ID, "{id}");
                let owner = address_from_bytes(&seeds[0]);
                let mint = address_from_bytes(&seeds[2]);
                let derived = fx::associated_token_address(&owner, &mint);
                assert_eq!(derived, expected.0, "{id}: ATA");
            }
            other => panic!("{id}: unknown kind {other}"),
        }
    }
}

#[test]
fn placeholder_vectors_reproduce_the_contract_table() {
    let vectors = pda_vectors();
    let pda = |id: &str| expected_pda(find_vector(&vectors, id));
    // Recipient ATAs do not depend on the program id.
    let devnet_recipient = pda("devnet_recipient_ata_test_key_1").0;
    assert_eq!(devnet_recipient, fx::vectors::DEVNET_RECIP_ATA);
    let mainnet_recipient = pda("mainnet_usdc_recipient_ata_test_key_1").0;
    assert_eq!(mainnet_recipient, fx::vectors::MAINNET_RECIP_ATA);
    let status = vectors[0].get("program_status").as_str();
    if status != "placeholder" {
        return;
    }
    let program_data = fx::vectors::PROGRAM_DATA;
    let program_data_bump = fx::vectors::PROGRAM_DATA_BUMP;
    let expected = (program_data, program_data_bump);
    // ProgramData does not depend on the mint, so it has one vector.
    assert_eq!(pda("devnet_program_data"), expected);
    let vault = fx::vectors::DEVNET_VAULT;
    let vault_bump = fx::vectors::DEVNET_VAULT_BUMP;
    assert_eq!(pda("devnet_vault"), (vault, vault_bump));
    let vault = fx::vectors::MAINNET_VAULT;
    let vault_bump = fx::vectors::MAINNET_VAULT_BUMP;
    assert_eq!(pda("mainnet_usdc_vault"), (vault, vault_bump));
    let vault_ata = pda("devnet_vault_ata").0;
    assert_eq!(vault_ata, fx::vectors::DEVNET_VAULT_ATA);
    let vault_ata = pda("mainnet_usdc_vault_ata").0;
    assert_eq!(vault_ata, fx::vectors::MAINNET_VAULT_ATA);
    let receipt = fx::vectors::DEVNET_RECEIPT;
    let receipt_bump = fx::vectors::DEVNET_RECEIPT_BUMP;
    assert_eq!(pda("devnet_receipt_1"), (receipt, receipt_bump));
    let receipt = fx::vectors::MAINNET_RECEIPT;
    let receipt_bump = fx::vectors::MAINNET_RECEIPT_BUMP;
    assert_eq!(pda("mainnet_usdc_receipt_1"), (receipt, receipt_bump));
}
