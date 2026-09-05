package main

// A minimal S3 client over plain HTTPS: signed GETs and ListObjectsV2. No SDK.

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type S3Client struct {
	Bucket, Region              string
	AccessKey, SecretKey, Token string
	HTTP                        *http.Client
}

var ErrNotFound = errors.New("no such key")

func (c *S3Client) host() string {
	return c.Bucket + ".s3." + c.Region + ".amazonaws.com"
}

// get performs one signed GET, retrying transient failures. key is the raw
// (unencoded) object key; query values are raw. Caller closes the body on success.
func (c *S3Client) get(key string, query url.Values) (*http.Response, error) {
	canonicalURI := "/" + uriEncode(key, false)

	type kv struct{ k, v string }
	var pairs []kv
	for k, vs := range query {
		for _, v := range vs {
			pairs = append(pairs, kv{uriEncode(k, true), uriEncode(v, true)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	qparts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		qparts = append(qparts, p.k+"="+p.v)
	}
	canonicalQuery := strings.Join(qparts, "&")

	rawURL := "https://" + c.host() + canonicalURI
	if canonicalQuery != "" {
		rawURL += "?" + canonicalQuery
	}

	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(500<<(attempt-1)) * time.Millisecond)
		}
		req, err := http.NewRequest("GET", rawURL, nil)
		if err != nil {
			return nil, err
		}
		signV4(req, canonicalURI, canonicalQuery, emptyPayloadSHA256,
			c.Region, "s3", c.AccessKey, c.SecretKey, c.Token, time.Now())
		resp, err := c.HTTP.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		switch {
		case resp.StatusCode == 200:
			return resp, nil
		case resp.StatusCode == 404:
			resp.Body.Close()
			return nil, ErrNotFound
		case resp.StatusCode >= 500 || resp.StatusCode == 429:
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			lastErr = fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
			continue
		default:
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			return nil, fmt.Errorf("HTTP %d for %s: %s", resp.StatusCode, key, body)
		}
	}
	return nil, fmt.Errorf("GET %s: %w", key, lastErr)
}

// GetObject downloads a whole object into memory (used for snapshots and records).
func (c *S3Client) GetObject(key string) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		resp, err := c.get(key, nil)
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err == nil {
			return data, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("GET %s: body read: %w", key, lastErr)
}

// GetObjectStream opens an object for streaming; the caller must Close it.
func (c *S3Client) GetObjectStream(key string) (io.ReadCloser, int64, error) {
	resp, err := c.get(key, nil)
	if err != nil {
		return nil, 0, err
	}
	return resp.Body, resp.ContentLength, nil
}

type listBucketResult struct {
	Contents []struct {
		Key  string `xml:"Key"`
		Size int64  `xml:"Size"`
	} `xml:"Contents"`
	CommonPrefixes []struct {
		Prefix string `xml:"Prefix"`
	} `xml:"CommonPrefixes"`
	IsTruncated           bool   `xml:"IsTruncated"`
	NextContinuationToken string `xml:"NextContinuationToken"`
}

// List runs ListObjectsV2 with the given prefix and optional delimiter, following
// continuation tokens. Returns object keys and common prefixes.
func (c *S3Client) List(prefix, delimiter string) (keys []string, prefixes []string, err error) {
	token := ""
	for {
		q := url.Values{}
		q.Set("list-type", "2")
		if prefix != "" {
			q.Set("prefix", prefix)
		}
		if delimiter != "" {
			q.Set("delimiter", delimiter)
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		resp, err := c.get("", q)
		if err != nil {
			return nil, nil, err
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, nil, err
		}
		var lr listBucketResult
		if err := xml.Unmarshal(data, &lr); err != nil {
			return nil, nil, fmt.Errorf("list %q: bad XML: %w", prefix, err)
		}
		for _, o := range lr.Contents {
			keys = append(keys, o.Key)
		}
		for _, p := range lr.CommonPrefixes {
			prefixes = append(prefixes, p.Prefix)
		}
		if !lr.IsTruncated {
			return keys, prefixes, nil
		}
		token = lr.NextContinuationToken
	}
}
