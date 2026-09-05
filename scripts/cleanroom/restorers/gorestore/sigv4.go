package main

// AWS Signature Version 4 signing, written from public AWS documentation knowledge.
// No SDK involved anywhere.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"sort"
	"strings"
	"time"
)

// SHA-256 of the empty string: the payload hash for every request we make (all GETs).
const emptyPayloadSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

// uriEncode implements SigV4's URI encoding: unreserved bytes A-Z a-z 0-9 - . _ ~
// pass through, every other byte becomes %XX with uppercase hex. '/' is preserved
// only when encodeSlash is false (path encoding); query keys/values encode it.
func uriEncode(s string, encodeSlash bool) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0xF])
		}
	}
	return b.String()
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// signV4 signs req in place. canonicalURI and canonicalQuery must be exactly what
// goes on the wire (already encoded). Signs host plus every header currently set on
// the request, so callers set only headers they mean to sign before calling.
func signV4(req *http.Request, canonicalURI, canonicalQuery, payloadHash,
	region, service, accessKey, secretKey, sessionToken string, now time.Time) {

	amzDate := now.UTC().Format("20060102T150405Z")
	dateStamp := now.UTC().Format("20060102")

	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)
	if sessionToken != "" {
		req.Header.Set("x-amz-security-token", sessionToken)
	}

	type hdr struct{ name, value string }
	hdrs := []hdr{{"host", req.Host}}
	if req.Host == "" {
		hdrs[0].value = req.URL.Host
	}
	for name, vals := range req.Header {
		hdrs = append(hdrs, hdr{strings.ToLower(name), strings.TrimSpace(vals[0])})
	}
	sort.Slice(hdrs, func(i, j int) bool { return hdrs[i].name < hdrs[j].name })

	var ch, sh strings.Builder
	for i, h := range hdrs {
		ch.WriteString(h.name)
		ch.WriteByte(':')
		ch.WriteString(h.value)
		ch.WriteByte('\n')
		if i > 0 {
			sh.WriteByte(';')
		}
		sh.WriteString(h.name)
	}
	signedHeaders := sh.String()

	canonicalRequest := strings.Join([]string{
		req.Method, canonicalURI, canonicalQuery, ch.String(), signedHeaders, payloadHash,
	}, "\n")

	scope := strings.Join([]string{dateStamp, region, service, "aws4_request"}, "/")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	kDate := hmacSHA256([]byte("AWS4"+secretKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))

	req.Header.Set("Authorization",
		"AWS4-HMAC-SHA256 Credential="+accessKey+"/"+scope+
			", SignedHeaders="+signedHeaders+", Signature="+signature)
}
