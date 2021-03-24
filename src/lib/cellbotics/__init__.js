// .. Copyright (C) 2012-2020 Bryan A. Jones.
//
//  This file is part of the CellBotics system.
//
//  The CellBotics system is free software: you can redistribute it and/or
//  modify it under the terms of the GNU General Public License as
//  published by the Free Software Foundation, either version 3 of the
//  License, or (at your option) any later version.
//
//  The CellBotics system is distributed in the hope that it will be
//  useful, but WITHOUT ANY WARRANTY; without even the implied warranty
//  of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
//  General Public License for more details.
//
//  You should have received a copy of the GNU General Public License
//  along with the CellBotics system.  If not, see
//  <http://www.gnu.org/licenses/>.
//
// ***********************************************************************
// |docname| - JavaScript code to integrate the CellBot module into Skulpt
// ***********************************************************************
//
// Approach
// ========
// This is a somewhat unusual Python module: it relies on JavaScript code not stored in Skulpt, because:
//
// #.   The "Pair" button needs to access JavaScript code that's available before this module is imported by Python. So, the code in ``ble.js`` cannot be placed in this module. Instead, it's hosted in Runestone Components.
// #.   The JavaScript backend consists of several JavaScript files; there's not an easy way to include a bunch of JS files in Skulpt. Things that don't work: making each a fake Python module (they're evaled in separate namespaces), directly evaling the JS code stored in Sk.builtinFiles.files (same reason). So, these are hosted in Runestone Components. In addition, this allows us to dynamically load the relevant code, instead of loading it on every invocation of Skulpt (even when it's not used).

"use strict";


// Utilities
// =========
// This function turns a JavaScript Promise into its Skulpt equivalent, a suspension.
function promiseToPy(promise_) {
    const susp = new Sk.misceval.Suspension();
    let resolution;
    let exception;

    susp.resume = function() {
        if (exception) {
            throw exception;
        } else {
            return resolution;
        }
    };

    susp.data = {
        type: "Sk.promise",
        promise: promise_.then(function(value) {
            resolution = value;
            return value;
        }, function(err) {
            exception = err;
            return err;
        })
    };

    return susp;
}


// Given a JavaScript return value, remap it to Python. If it's a Promise, convert to a suspension first.
function remapToPy(js_value) {
    if (js_value instanceof Promise) {
        js_value = promiseToPy(js_value);
    }
    return  Sk.ffi.remapToPy(js_value);
}


// Returns a function that calls the provided JavaScript function on the provided Python parameters, first converting the parameters to JavaScript.
function remapToJsFunc(
    // The JavaScript function to invoke.
    js_func,
    // The expected number of arguments for this function; if empty, no argument checking is performed. Otherwise, this parameter is passed directly to ``Sk.builtin.pyCheckArgs`` (defined in ``src/function.js``):
    ...expected_args
    //
    // Note: it would be nice to simply query ``js_func`` for the number of arguments, but this is `hard <https://stackoverflow.com/questions/1007981/how-to-get-function-parameter-names-values-dynamically>`_.
) {
    return function(
        // The arguments from Python.
        ...args
    ) {
        if (expected_args) {
            // Convert a number to an array, so we can use it in the spread below.
            Sk.builtin.pyCheckArgs(js_func.name, args, ...expected_args);
        }

        // Drop the first argument (self) when calling the JavaScript equivalent -- the function to call is already a method of a class, so ``self`` isn't needed.
        args = args.slice(1);

        // Convert all args to JS. Convert the return type back to Python (handling a Promise if necessary).
        const ret = js_func(...args.map(x => Sk.ffi.remapToJs(x)));
        return remapToPy(ret);
    };
}


// Python cellbotics module
// ========================
// This is based on the instructions under the "Adding a Module" heading of `Programming Skulpt <https://skulpt.org/docs/index.html>`_.
var $builtinmodule = function(name) {
    // Use a promise to dynamically load JavaScript; after it's loaded, define the module (which depends on the loaded JS). Note that ``runestone_import`` is defined in the Runestone Components; the code imported resides the ble Runestone component.
    return remapToPy(Promise.all(
        [runestone_import("ble"), runestone_import("simple_sensor")]
    ).then(([ble_module, simple_sensor]) => {

        // Define a variable to store the module we're building.
        const mod = {__name__: new Sk.builtin.str("cellbotics")};

        // Provide a way to get a Python object's underlying JavaScript class, which is stored in its ``__js_class`` attribute by the following code. Avoid errors if ``self`` isn't valid.
        const get_self = self => self && self.__js_class;


        // Python/JavaScript property bridge
        ///=================================
        // Create a class that converts a JavaScript read-only property into a Python read-only property. To do this, define a class with a `Python descriptor <https://docs.python.org/3/howto/descriptor.html>`_.
        mod.JsProperty = Sk.misceval.buildClass(mod, function($gbl, $loc) {

            // Store the JavaScript property name this class returns, since there's not a nice way to introspect a class instance's name in Python. Arguments are ``self``, ``property_name`` -- a JavaScript string specifying the name of the property to return.
            $loc.__init__ = new Sk.builtin.func(function(...args) {
                // Check and assign the arguments.
                Sk.builtin.pyCheckArgs("__init__", args, 2, 2);
                const [self, property_name] = args;
                // The property name is available only to JavaScript, since that's the only code that uses it.
                self.__js_property = Sk.ffi.remapToJs(property_name);
            });

            // The ``__get__`` method provides read-only property access.
            $loc.__get__ = new Sk.builtin.func(function(...args) {
                // Check and assign the arguments.
                Sk.builtin.pyCheckArgs("__get__", args, 2, 3);
                const [self, obj, objtype] = args;
                // Python passes the object containing this class as ``obj``. From that, retrieve the JavaScript class to use.
                const js_class = get_self(obj);
                // Return the property of the class configured in the constructor above.
                return remapToPy(js_class[self.__js_property]);
            });
        }, "JsProperty", []);

        // Given the property name as JavaScript string, return an instance of the ``JsProperty`` class whose getter method retrieves this property from the underlying JavaScript object.
        const prop_wrap = prop_name => Sk.misceval.callsim(mod.JsProperty, new Sk.builtins["str"](prop_name));


        // CellBot
        ///=======
        // Create the main CellBot class if BLE is available.
        const ble = ble_module.cell_bot_ble_gui.cell_bot_ble;
        if (ble) {
            mod.CellBot = Sk.misceval.buildClass(mod, function($gbl, $loc) {
                $loc.__init__ = new Sk.builtin.func(function(self) {
                    if (!ble.paired()) {
                        throw "The CellBot is not paired. Click on the Pair button before running your program.";
                    }

                    // Reset the hardware before doing any other hardware operation. Since the constructor must return null, call it this way:
                    return remapToPy(ble.resetHardware().then(() => undefined));
                });

                // Define Arduino constants.
                $loc.INPUT = new Sk.builtin.int_(ble.INPUT);
                $loc.OUTPUT = new Sk.builtin.int_(ble.OUTPUT);

                // The way we wrap all these JavaScript methods to embed them in Skulpt.
                const wrap = (f, num_args) =>
                    new Sk.builtin.func(remapToJsFunc(f, num_args, num_args));

                // Provide Arduino functions via a JavaScript RPC.
                $loc.resetHardware = wrap(ble.resetHardware, 1);
                $loc.pinMode = wrap(ble.pinMode, 3);
                $loc.digitalWrite = wrap(ble.digitalWrite, 3);
                $loc.digitalRead = wrap(ble.digitalRead, 2);
                $loc.ledcSetup = wrap(ble.ledcSetup, 4);
                $loc.ledcAttachPin = wrap(ble.ledcAttachPin, 3);
                $loc.ledcDetachPin = wrap(ble.ledcDetachPin, 2);
                $loc.ledcWrite = wrap(ble.ledcWrite, 3);

            }, "CellBot", []);
        }


        // Sensors
        ///=======
        // These function wrap the sensors in ``SimpleSensors.js``.
        //
        // A handy shortcut for wrapping methods in this class.
        const method_wrap = (method_name, num_args) => new Sk.builtin.func(
            (...args) =>
                remapToJsFunc(get_self(args[0])[method_name], num_args, num_args)(...args)
        );

        // Create an "Abstract" base class that has non-functional start and stop methods.
        mod._Sensor = Sk.misceval.buildClass(mod, function($gbl, $loc) {
            $loc.start = method_wrap("start", 1);
            $loc.stop = method_wrap("stop", 1);

        }, "_Sensor", []);

        // Subclass this to produce another "abstract" base class for xyz readings.
        mod._XYZSensor = Sk.misceval.buildClass(mod, function($gbl, $loc) {
            $loc.x = prop_wrap("x", 1);
            $loc.y = prop_wrap("y", 1);
            $loc.z = prop_wrap("z", 1);

        }, "_XYZSensor", [mod._Sensor]);


        // Repeat for orientation sensors.
        mod._OrientationSensor = Sk.misceval.buildClass(mod, function($gbl, $loc) {
            $loc.quaternion = prop_wrap("quaternion", 1);

        }, "_OrientationSensor", [mod._Sensor]);


        // Create a factory for making classes for these sensors.
        const sensor_factory = (py_name, py_superclass, js_class) =>
            mod[py_name] = Sk.misceval.buildClass(mod, function($gbl, $loc) {
                $loc.__init__ = new Sk.builtin.func(function(...args) {
                    Sk.builtin.pyCheckArgs("__init__", [args], 1, 1);
                    args[0].__js_class = new js_class();
                });

            }, py_name, [py_superclass]);

        // Concrete classes
        ///----------------
        mod.AmbientLightSensor = Sk.misceval.buildClass(mod, function($gbl, $loc) {
            $loc.__init__ = new Sk.builtin.func(function(...args) {
                Sk.builtin.pyCheckArgs("__init__", [args], 1, 1);
                args[0].__js_class = new simple_sensor.SimpleAmbientLightSensor();
            });

            $loc.illuminance = prop_wrap("illuminance");

        }, "AmbientLightSensor", [mod._Sensor]);

        mod.GeolocationSensor = Sk.misceval.buildClass(mod, function($gbl, $loc) {
            $loc.__init__ = new Sk.builtin.func(function(...args) {
                Sk.builtin.pyCheckArgs("__init__", [args], 1, 1);
                args[0].__js_class = new simple_sensor.SimpleGeolocationSensor();
            });

            $loc.latitude = prop_wrap("latitude");
            $loc.longitude = prop_wrap("longitude");
            $loc.altitude = prop_wrap("altitude");
            $loc.accuracy = prop_wrap("accuracy");
            $loc.altitudeAccuracy = prop_wrap("altitudeAccuracy");
            $loc.heading = prop_wrap("heading");
            $loc.speed = prop_wrap("speed");

        }, "GeolocationSensor", [mod._Sensor]);

        sensor_factory("Accelerometer", mod._XYZSensor, simple_sensor.SimpleAccelerometer);
        sensor_factory("Gyroscope", mod._XYZSensor, simple_sensor.SimpleGyroscope);
        sensor_factory("Magnetometer", mod._XYZSensor, simple_sensor.SimpleMagnetometer);
        sensor_factory("LinearAccelerationSensor", mod._XYZSensor, simple_sensor.SimpleLinearAccelerationSensor);
        sensor_factory("GravitySensor", mod._XYZSensor, simple_sensor.SimpleGravitySensor);
        sensor_factory("AbsoluteOrientationSensor", mod._OrientationSensor, simple_sensor.SimpleAbsoluteOrientationSensor);
        sensor_factory("RelativeOrientationSensor", mod._OrientationSensor, simple_sensor.SimpleRelativeOrientationSensor);

        return mod;
    }));
};
