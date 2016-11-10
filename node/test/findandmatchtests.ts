// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

/// <reference path="../typings/index.d.ts" />
/// <reference path="../_build/task.d.ts" />

import assert = require('assert');
import * as tl from '../_build/task';
import * as fs from 'fs';
import * as path from 'path';
import testutil = require('./testutil');

describe('Find and Match Tests', function () {

    before(function (done) {
        try {
            testutil.initialize();
        }
        catch (err) {
            assert.fail('Failed to load task lib: ' + err.message);
        }
        done();
    });

    after(function () {
    });

    it('single pattern', (done: MochaDone) => {
        this.timeout(1000);

        // create the following layout:
        //   hello.txt
        //   world.txt
        //   zzz.zzz
        let root: string = path.join(testutil.getTestTemp(), 'find-and-match_single-pattern');
        tl.mkdirP(root);
        fs.writeFileSync(path.join(root, 'hello.txt'), '');
        fs.writeFileSync(path.join(root, 'world.txt'), '');
        fs.writeFileSync(path.join(root, 'zzz.zzz'), '');

        let actual: string[] = tl.findAndMatch('', path.join(root, '*.txt'));
        let expected: string[] = [
            path.join(root, 'hello.txt'),
            path.join(root, 'world.txt'),
        ];

        done();
    });

    // it('aggregates matches', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '/projects/myproj1/myproj1.proj',
    //         '/projects/myproj2/myproj2.proj',
    //         '/projects/myproj3/myproj3.proj'
    //     ];
    //     let patterns: string[] = [
    //         '/projects/**/myproj1.proj',
    //         '/projects/**/myproj2.proj'
    //     ];
    //     let options: tl.MatchOptions = { matchBase: true };
    //     let result: string[] = tl.match(list, patterns, options);
    //     assert.equal(result.length, 2);
    //     assert.equal(result[0], '/projects/myproj1/myproj1.proj');
    //     assert.equal(result[1], '/projects/myproj2/myproj2.proj');

    //     done();
    // });

    // it('does not duplicate matches', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '/included/file1.proj',
    //         '/included/file2.proj',
    //         '/not_included/readme.txt'
    //     ];
    //     let patterns: string[] = [
    //         '/included/**', // both patterns match the same files
    //         '/**/*.proj'
    //     ];
    //     let options: tl.MatchOptions = { matchBase: true };
    //     let result: string[] = tl.match(list, patterns, options);
    //     assert.equal(result.length, 2);
    //     assert.equal(result[0], '/included/file1.proj');
    //     assert.equal(result[1], '/included/file2.proj');

    //     done();
    // });

    // it('preserves order', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '/projects/myproj1/myproj1.proj',
    //         '/projects/myproj2/myproj2.proj',
    //         '/projects/myproj3/myproj3.proj',
    //         '/projects/myproj4/myproj4.proj',
    //         '/projects/myproj5/myproj5.proj'
    //     ];
    //     let patterns: string[] = [
    //         '/projects/**/myproj2.proj', // mix up the order
    //         '/projects/**/myproj5.proj',
    //         '/projects/**/myproj3.proj',
    //         '/projects/**/myproj1.proj',
    //         '/projects/**/myproj4.proj',
    //     ];
    //     let options: tl.MatchOptions = { matchBase: true };
    //     let result: string[] = tl.match(list, patterns, options);
    //     assert.equal(result.length, 5);
    //     assert.equal(result[0], '/projects/myproj1/myproj1.proj'); // should follow original list order
    //     assert.equal(result[1], '/projects/myproj2/myproj2.proj');
    //     assert.equal(result[2], '/projects/myproj3/myproj3.proj');
    //     assert.equal(result[3], '/projects/myproj4/myproj4.proj');
    //     assert.equal(result[4], '/projects/myproj5/myproj5.proj');

    //     done();
    // });

    // it('supports interleaved exclude patterns', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '/solution1/proj1/proj1.proj',
    //         '/solution1/proj1/README.txt',
    //         '/solution1/proj2/proj2.proj',
    //         '/solution1/proj2/README.txt',
    //         '/solution1/solution1.sln',
    //         '/solution2/proj1/proj1.proj',
    //         '/solution2/proj1/README.txt',
    //         '/solution2/proj2/proj2.proj',
    //         '/solution2/proj2/README.txt',
    //         '/solution2/solution2.sln',
    //     ];
    //     let patterns: string[] = [
    //         '**/@(*.proj|README.txt)',  // include all proj and README files
    //         '!**/solution2/**',         // exclude the solution 2 folder entirely
    //         '**/*.sln',                 // include all sln files
    //         '!**/proj2/README.txt'      // exclude proj2 README files
    //     ];
    //     let result: string[] = tl.match(list, patterns);
    //     assert.equal(result.length, 5);
    //     assert.equal(result[0], '/solution1/proj1/proj1.proj');
    //     assert.equal(result[1], '/solution1/proj1/README.txt');
    //     assert.equal(result[2], '/solution1/proj2/proj2.proj');
    //     assert.equal(result[3], '/solution1/solution1.sln');
    //     assert.equal(result[4], '/solution2/solution2.sln');

    //     done();
    // });

    // it('applies default options', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '/brace-test/brace_{hello,world}.txt',
    //         '/brace-test/brace_hello.txt',
    //         '/brace-test/brace_world.txt',
    //         '/glob-star-test/hello/world/hello-world.txt',
    //         '/glob-star-test/hello/hello.txt',
    //         '/glob-star-test/glob-star-test.txt',
    //         '/dot-test/.hello/.world.txt',
    //         '/dot-test/.hello/other.zzz',
    //         '/ext-glob-test/@(hello|world).txt',
    //         '/ext-glob-test/hello.txt',
    //         '/ext-glob-test/world.txt',
    //         '/case-test/hello.txt',
    //         '/case-test/world.TXT',
    //         '/match-base-test/match-base-file.txt',
    //         'match-base-file.txt',
    //         '#comment-test',
    //         '!/negate-test/hello.txt',
    //         '/negate-test/hello.txt',
    //         '/negate-test/world.txt',
    //     ];
    //     let patterns: string[] = [
    //         '/brace-test/brace_{hello,world}.txt',
    //         '/glob-star-test/**',
    //         '/dot-test/*/*.txt',
    //         '/ext-glob-test/@(hello|world).txt',
    //         '/case-test/*.txt',
    //         'match-base-file.txt',
    //         '#comment-test',
    //         '/negate-test/*',
    //         '!/negate-test/hello.txt',
    //     ];
    //     let actual: string[] = tl.match(list, patterns);
    //     let expected: string[] = [];
    //     expected.push('/brace-test/brace_{hello,world}.txt');
    //     expected.push('/glob-star-test/hello/world/hello-world.txt');
    //     expected.push('/glob-star-test/hello/hello.txt');
    //     expected.push('/glob-star-test/glob-star-test.txt');
    //     expected.push('/dot-test/.hello/.world.txt');
    //     expected.push('/ext-glob-test/hello.txt');
    //     expected.push('/ext-glob-test/world.txt');
    //     expected.push('/case-test/hello.txt');
    //     if (process.platform == 'win32') {
    //         expected.push('/case-test/world.TXT');
    //     }

    //     expected.push('match-base-file.txt');
    //     expected.push('/negate-test/world.txt');
    //     assert.deepEqual(actual, expected);

    //     done();
    // });

    // it('trims patterns', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         ' hello-world.txt ',
    //         'hello-world.txt',
    //     ];
    //     let patterns: string[] = [
    //         ' hello-world.txt ',
    //     ];
    //     let actual: string[] = tl.match(list, patterns);
    //     let expected: string[] = [
    //         'hello-world.txt'
    //     ];
    //     assert.deepEqual(actual, expected);

    //     done();
    // });

    // it('skips empty patterns', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '',
    //         ' ',
    //         'hello-world.txt',
    //     ];
    //     let patterns: string[] = [
    //         '',
    //         ' ',
    //         'hello-world.txt',
    //     ];
    //     let actual: string[] = tl.match(list, patterns);
    //     let expected: string[] = [
    //         'hello-world.txt'
    //     ];
    //     assert.deepEqual(actual, expected);

    //     done();
    // });

    // it('supports nocomment true', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '#hello-world.txt',
    //         'hello-world.txt',
    //     ];
    //     let patterns: string[] = [
    //         '#hello-world.txt',
    //     ];
    //     let actual: string[] = tl.match(list, patterns, <tl.MatchOptions>{ nocomment: true });
    //     let expected: string[] = [
    //         '#hello-world.txt'
    //     ];
    //     assert.deepEqual(actual, expected);

    //     done();
    // });

    // it('supports nonegate true', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '!hello-world.txt',
    //         'hello-world.txt',
    //     ];
    //     let patterns: string[] = [
    //         '!hello-world.txt',
    //     ];
    //     let actual: string[] = tl.match(list, patterns, <tl.MatchOptions>{ nonegate: true });
    //     let expected: string[] = [
    //         '!hello-world.txt'
    //     ];
    //     assert.deepEqual(actual, expected);

    //     done();
    // });

    // it('supports flipnegate true', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '!hello-world.txt',
    //         'hello-world.txt',
    //     ];
    //     let patterns: string[] = [
    //         '!hello-world.txt',
    //     ];
    //     let actual: string[] = tl.match(list, patterns, <tl.MatchOptions>{ flipNegate: true });
    //     let expected: string[] = [
    //         'hello-world.txt'
    //     ];
    //     assert.deepEqual(actual, expected);

    //     done();
    // });

    // it('counts leading negate markers', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         '/hello/world.txt',
    //         '/hello/two-negate-markers.txt',
    //         '/hello/four-negate-markers.txt',
    //         '/initial-includes/hello.txt',
    //         '/initial-includes/one-negate-markers.txt',
    //         '/initial-includes/three-negate-markers.txt',
    //     ];
    //     let patterns: string[] = [
    //         '/initial-includes/*.txt',
    //         '!!/hello/two-negate-markers.txt',
    //         '!!!!/hello/four-negate-markers.txt',
    //         '!/initial-includes/one-negate-markers.txt',
    //         '!!!/initial-includes/three-negate-markers.txt',
    //     ];
    //     let actual: string[] = tl.match(list, patterns);
    //     let expected: string[] = [
    //         '/hello/two-negate-markers.txt',
    //         '/hello/four-negate-markers.txt',
    //         '/initial-includes/hello.txt',
    //     ];
    //     assert.deepEqual(actual, expected);

    //     done();
    // });

    // it('trims whitespace after trimming negate markers', (done: MochaDone) => {
    //     this.timeout(1000);

    //     let list: string[] = [
    //         'hello.txt',
    //         'world.txt',
    //     ];
    //     let patterns: string[] = [
    //         '*',
    //         '! hello.txt',
    //     ];
    //     let actual: string[] = tl.match(list, patterns);
    //     let expected: string[] = [
    //         'world.txt',
    //     ];
    //     assert.deepEqual(actual, expected);

    //     done();
    // });
});
