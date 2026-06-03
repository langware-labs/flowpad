pub mod keychain;

pub use keychain::{
    delete_key as rust_delete_key,
    get_key as rust_get_key,
    get_key_restricted as rust_get_key_restricted,
    set_key as rust_set_key,
    set_key_restricted as rust_set_key_restricted,
};

#[cfg(feature = "python")]
use pyo3::prelude::*;

#[cfg(feature = "python")]
#[pyfunction]
#[pyo3(name = "get_key")]
fn py_get_key(service: &str, name: &str) -> PyResult<Option<String>> {
    keychain::get_key(service, name)
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[cfg(feature = "python")]
#[pyfunction]
#[pyo3(name = "set_key")]
fn py_set_key(service: &str, name: &str, val: &str) -> PyResult<()> {
    keychain::set_key(service, name, val)
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[cfg(feature = "python")]
#[pyfunction]
#[pyo3(name = "delete_key")]
fn py_delete_key(service: &str, name: &str) -> PyResult<()> {
    keychain::delete_key(service, name)
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[cfg(feature = "python")]
#[pyfunction]
#[pyo3(name = "set_key_restricted")]
fn py_set_key_restricted(service: &str, name: &str, val: &str) -> PyResult<()> {
    keychain::set_key_restricted(service, name, val)
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[cfg(feature = "python")]
#[pyfunction]
#[pyo3(name = "get_key_restricted")]
fn py_get_key_restricted(service: &str, name: &str) -> PyResult<Option<String>> {
    keychain::get_key_restricted(service, name)
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[cfg(feature = "python")]
#[pymodule]
fn flow_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(py_get_key, m)?)?;
    m.add_function(wrap_pyfunction!(py_set_key, m)?)?;
    m.add_function(wrap_pyfunction!(py_delete_key, m)?)?;
    m.add_function(wrap_pyfunction!(py_set_key_restricted, m)?)?;
    m.add_function(wrap_pyfunction!(py_get_key_restricted, m)?)?;
    Ok(())
}
